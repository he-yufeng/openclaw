// Covers #158261: local models emitting snake_case memory_search arguments.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeMemorySearchArguments } from "./memory-search-arguments.js";
import { MEMORY_SEARCH_TOOL_CONTRACT } from "./memory-tool-contract.js";
import { createMemoryGetToolOrThrow, createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

describe("normalizeMemorySearchArguments", () => {
  it("maps snake_case keys onto the canonical camelCase properties", () => {
    expect(
      normalizeMemorySearchArguments({ query: "backups", min_score: 0.3, max_results: 5 }),
    ).toEqual({ query: "backups", minScore: 0.3, maxResults: 5 });
  });

  it("keeps explicit camelCase values when both spellings arrive", () => {
    expect(
      normalizeMemorySearchArguments({ query: "backups", minScore: 0.8, min_score: 0.3 }),
    ).toEqual({ query: "backups", minScore: 0.8 });
  });

  it("does not invent keys the model never sent", () => {
    expect(normalizeMemorySearchArguments({ query: "backups" })).toEqual({ query: "backups" });
  });

  it("tolerates non-record input", () => {
    expect(normalizeMemorySearchArguments(undefined)).toEqual({});
    expect(normalizeMemorySearchArguments("min_score")).toEqual({});
  });

  it("produces arguments the strict tool schema accepts", () => {
    const normalized = normalizeMemorySearchArguments({
      query: "backups",
      min_score: 0.3,
      max_results: 5,
      corpus: "memory",
    });
    expect(Value.Check(MEMORY_SEARCH_TOOL_CONTRACT.parameters, normalized)).toBe(true);
  });
});

describe("memory_search tool wiring", () => {
  it("forwards prepareArguments from the factory", () => {
    const tool = createMemorySearchToolOrThrow();
    expect(tool.prepareArguments).toBe(normalizeMemorySearchArguments);
  });

  it("leaves memory_get without argument aliases", () => {
    expect(createMemoryGetToolOrThrow().prepareArguments).toBeUndefined();
  });
});
