/** Overflow recovery for Codex app-server binding state (#125910). */
import type {
  PluginStateEntry,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  readStoredCodexAppServerBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

// Overflow retries per insert. Each retry means a just-freed row was claimed
// by a racing insert; past a few, fail with the limit error instead of
// evicting rows in an unbounded loop.
const BINDING_INSERT_EVICTION_ATTEMPTS = 4;
// The sync store can only list the namespace wholesale, so one entries()
// snapshot serves a whole recovery episode: repeated row-limit failures
// inside this window reuse it instead of re-decoding every row per attempt.
const BINDING_OVERFLOW_SNAPSHOT_TTL_MS = 5_000;
// Rows schema-parsed per slice while hunting one disposable candidate, so a
// namespace full of protected rows does not also pay a full parse per attempt.
const BINDING_OVERFLOW_PARSE_CHUNK = 512;

type BindingStateUpdate = NonNullable<
  PluginStateSyncKeyedStore<StoredCodexAppServerBinding>["update"]
>;
type BindingStateEntry = PluginStateEntry<StoredCodexAppServerBinding>;

// A full namespace must not hard-fail every new session. Only row-count
// overflows free a row on retry: the same code also covers value-size
// rejects, which no eviction can fix.
function isCodexBindingRowLimitError(error: unknown): boolean {
  return (
    // SAFETY: probing an unknown thrown value; absent code reads as undefined.
    (error as { code?: unknown }).code === "PLUGIN_STATE_LIMIT_EXCEEDED" &&
    error instanceof Error &&
    error.message.includes("row limit")
  );
}

// Destructive eligibility is decided on the raw record, not the tolerant
// codec: readStoredCodexAppServerBinding catches a malformed lease or
// retirement marker to undefined, which would make an ambiguous row look
// unprotected. Anything uncertain is preserved.
function readRawLeaseProtection(
  value: unknown,
): { kind: "none" } | { kind: "valid"; expiresAt: number } | { kind: "ambiguous" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "ambiguous" };
  }
  // SAFETY: the object guard above proves the record shape for the field read.
  const raw = (value as Record<string, unknown>).lease;
  if (raw === undefined) {
    return { kind: "none" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "ambiguous" };
  }
  // SAFETY: both fields are re-validated with typeof checks right after this.
  const { token, expiresAt } = raw as { token?: unknown; expiresAt?: unknown };
  if (typeof token !== "string" || !token.trim()) {
    return { kind: "ambiguous" };
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { kind: "ambiguous" };
  }
  return { kind: "valid", expiresAt };
}

// Only an abandoned cleared row may be shed for an insert. Retirement fences,
// legacy-clear provenance, live leases, active bindings, and any row whose raw
// protection fields do not parse cleanly are never candidates; without those
// exclusions a sweep could reopen native authority for stale owners.
function isDisposableBindingRow(
  key: string,
  value: unknown,
  stored: StoredCodexAppServerBinding,
  now: number,
): boolean {
  if (
    stored.state !== "cleared" ||
    stored.retired === true ||
    key.startsWith("conversation:legacy-")
  ) {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: the object guard above proves the record shape for the field read.
  const raw = value as Record<string, unknown>;
  // A retirement marker in any shape is a fence, not garbage.
  if (raw.retired !== undefined) {
    return false;
  }
  const lease = readRawLeaseProtection(value);
  return lease.kind === "none" || (lease.kind === "valid" && lease.expiresAt <= now);
}

/** Wraps binding-state updates with domain-ranked capacity recovery. */
export function withCodexBindingOverflowRecovery<
  TState extends Pick<
    PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
    "deleteIf" | "entries" | "update"
  >,
>(state: TState): TState {
  const update = state.update?.bind(state);
  const deleteIf = state.deleteIf?.bind(state);
  if (!update || !deleteIf) {
    // The facade reports missing atomic update/delete support itself.
    return state;
  }
  let episode: { at: number; entries: BindingStateEntry[]; cursor: number } | undefined;
  const episodeEntries = (now: number) => {
    if (!episode || now - episode.at >= BINDING_OVERFLOW_SNAPSHOT_TTL_MS) {
      episode = {
        at: now,
        entries: state.entries().toSorted((a, b) => a.createdAt - b.createdAt),
        cursor: 0,
      };
    }
    return episode;
  };
  const evictOneDisposableBindingRow = (insertKey: string): boolean => {
    const now = Date.now();
    const ep = episodeEntries(now);
    // One slice per call, continuing from the episode cursor: a namespace
    // full of protected rows never pays a full parse in one call, and the
    // failed insert simply retries into the next slice.
    const end = Math.min(ep.cursor + BINDING_OVERFLOW_PARSE_CHUNK, ep.entries.length);
    for (let i = ep.cursor; i < end; i++) {
      const entry = ep.entries[i]!;
      ep.cursor = i + 1;
      if (entry.key === insertKey) {
        continue;
      }
      const stored = readStoredCodexAppServerBinding(entry.value);
      if (!stored || !isDisposableBindingRow(entry.key, entry.value, stored, now)) {
        continue;
      }
      const evicted = deleteIf(entry.key, (current) => {
        const currentStored = readStoredCodexAppServerBinding(current);
        return (
          currentStored !== undefined &&
          isDisposableBindingRow(entry.key, current, currentStored, now)
        );
      });
      if (evicted) {
        // The next row shifts into this slot after the splice.
        ep.entries.splice(i, 1);
        ep.cursor = i;
        return true;
      }
    }
    return false;
  };
  const guardedUpdate: BindingStateUpdate = (key, updateValue, opts) => {
    let evictions = 0;
    while (true) {
      try {
        return update(key, updateValue, opts);
      } catch (error) {
        if (
          !isCodexBindingRowLimitError(error) ||
          evictions >= BINDING_INSERT_EVICTION_ATTEMPTS ||
          !evictOneDisposableBindingRow(key)
        ) {
          throw error;
        }
        evictions += 1;
      }
    }
  };
  return { ...state, update: guardedUpdate };
}
