/** Overflow recovery for Codex app-server binding state (#125910). */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  readStoredCodexAppServerBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

// Overflow retries per insert. Each retry means a just-freed row was claimed
// by a racing insert; past a few, fail with the limit error instead of
// evicting rows in an unbounded loop.
const BINDING_INSERT_EVICTION_ATTEMPTS = 4;

type BindingStateUpdate = NonNullable<
  PluginStateSyncKeyedStore<StoredCodexAppServerBinding>["update"]
>;

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

// Only an abandoned cleared row may be shed for an insert. Retirement fences,
// legacy-clear provenance, live leases, and active bindings are never
// candidates; without those exclusions a sweep could reopen native authority
// for stale owners.
function isDisposableBindingRow(
  key: string,
  stored: StoredCodexAppServerBinding,
  now: number,
): boolean {
  return (
    stored.state === "cleared" &&
    stored.retired !== true &&
    !key.startsWith("conversation:legacy-") &&
    (stored.lease === undefined || stored.lease.expiresAt <= now)
  );
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
  const evictOneDisposableBindingRow = (insertKey: string): boolean => {
    const now = Date.now();
    const candidates: { key: string; createdAt: number }[] = [];
    for (const entry of state.entries()) {
      if (entry.key === insertKey) {
        continue;
      }
      const stored = readStoredCodexAppServerBinding(entry.value);
      if (stored && isDisposableBindingRow(entry.key, stored, now)) {
        candidates.push({ key: entry.key, createdAt: entry.createdAt });
      }
    }
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of candidates) {
      const evicted = deleteIf(candidate.key, (current) => {
        const stored = readStoredCodexAppServerBinding(current);
        return stored !== undefined && isDisposableBindingRow(candidate.key, stored, now);
      });
      if (evicted) {
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
