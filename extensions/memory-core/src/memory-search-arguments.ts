import { asToolParamsRecord } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

// Local models occasionally call memory_search with snake_case keys
// (`min_score`, `max_results`). The schema forbids additional properties,
// so without normalization the call is rejected before execute — and before
// any before_tool_call hook — can see it (#158261).
const MEMORY_SEARCH_ARGUMENT_ALIASES = {
  max_results: "maxResults",
  min_score: "minScore",
} as const;

export function normalizeMemorySearchArguments(args: unknown): Record<string, unknown> {
  const params = { ...asToolParamsRecord(args) };
  for (const [alias, canonical] of Object.entries(MEMORY_SEARCH_ARGUMENT_ALIASES)) {
    if (params[canonical] === undefined && params[alias] !== undefined) {
      params[canonical] = params[alias];
    }
    delete params[alias];
  }
  return params;
}
