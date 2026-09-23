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
// One capacity failure sheds up to this many disposable rows, so a snapshot
// pays off across many inserts instead of one row per failure.
const BINDING_OVERFLOW_SHED_PER_CALL = 8;
// Slices scanned per failure: the per-call parse work stays bounded even
// when the cursor sits on a long protected prefix.
const BINDING_OVERFLOW_SCAN_SLICES_PER_CALL = 4;

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
  // The scan position survives a snapshot refresh, so spaced requests keep
  // advancing through the namespace instead of re-reading the same protected
  // prefix at every episode boundary.
  let lastExamined: { createdAt: number; key: string } | undefined;
  const resumeIndex = (
    entries: BindingStateEntry[],
    after: { createdAt: number; key: string },
  ): number => {
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const entry = entries[mid]!;
      if (
        entry.createdAt > after.createdAt ||
        (entry.createdAt === after.createdAt && entry.key > after.key)
      ) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  };
  const episodeEntries = (now: number) => {
    if (!episode || now - episode.at >= BINDING_OVERFLOW_SNAPSHOT_TTL_MS) {
      // Sort by the same (createdAt, key) order the resume cursor searches,
      // so equal timestamps cannot scramble the continuation point.
      const entries = state
        .entries()
        .toSorted(
          (a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        );
      let cursor = lastExamined ? resumeIndex(entries, lastExamined) : 0;
      if (cursor >= entries.length) {
        // A finished pass must not park the cursor past the end: rows already
        // examined can turn disposable once their leases lapse, so a full
        // pass with nothing newer than lastExamined starts over.
        cursor = 0;
      }
      episode = { at: now, entries, cursor };
    }
    return episode;
  };
  const evictDisposableBindingRows = (insertKey: string): number => {
    const now = Date.now();
    const ep = episodeEntries(now);
    // Each call sheds up to a few disposable rows so one snapshot serves many
    // inserts, and scans at most a few slices so the Gateway thread never
    // pays a full parse on a protected prefix.
    let shed = 0;
    let slices = 0;
    while (
      shed < BINDING_OVERFLOW_SHED_PER_CALL &&
      slices < BINDING_OVERFLOW_SCAN_SLICES_PER_CALL &&
      ep.cursor < ep.entries.length
    ) {
      let end = Math.min(ep.cursor + BINDING_OVERFLOW_PARSE_CHUNK, ep.entries.length);
      for (let i = ep.cursor; i < end && shed < BINDING_OVERFLOW_SHED_PER_CALL;) {
        const entry = ep.entries[i]!;
        lastExamined = { createdAt: entry.createdAt, key: entry.key };
        if (entry.key === insertKey) {
          i += 1;
          ep.cursor = i;
          continue;
        }
        const stored = readStoredCodexAppServerBinding(entry.value);
        if (!stored || !isDisposableBindingRow(entry.key, entry.value, stored, now)) {
          i += 1;
          ep.cursor = i;
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
          // The splice shrinks the slice with the array, so the loop bound
          // walks back with it instead of reading past the shifted end.
          ep.entries.splice(i, 1);
          end -= 1;
          ep.cursor = i;
          shed += 1;
          continue;
        }
        i += 1;
        ep.cursor = i;
      }
      slices += 1;
    }
    return shed;
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
          evictDisposableBindingRows(key) === 0
        ) {
          throw error;
        }
        evictions += 1;
      }
    }
  };
  return { ...state, update: guardedUpdate };
}
