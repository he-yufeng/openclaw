import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

function createThreeTurnSessionManager() {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
  sessionManager.appendMessage({
    ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
    timestamp: 2,
  });
  sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
  return sessionManager;
}

function recordCompactionThinkingLevel(sessionManager: SessionManager) {
  const seen: Array<string | undefined> = [];
  const hook = vi.fn(async (event: unknown) => {
    seen.push((event as { thinkingLevel?: string }).thinkingLevel);
    return {
      compaction: {
        summary: "Earlier work completed.",
        firstKeptEntryId: sessionManager.getBranch().at(-1)?.id ?? "root",
        tokensBefore: 2_000,
      },
    };
  });
  return {
    seen,
    resourceLoader: createResourceLoader(new Map([["session_before_compact", [hook]]])),
  };
}

describe("AgentSession compaction thinking level (#159424)", () => {
  it("runs compaction summaries at the configured level instead of the session level", async () => {
    const sessionManager = createThreeTurnSessionManager();
    const { seen, resourceLoader } = recordCompactionThinkingLevel(sessionManager);
    const { session } = await createTestSession({
      sessionManager,
      compactionThinkingLevel: "low",
      contextOverflowRecoveryOwner: "session",
      resourceLoader,
    });
    await session.setThinkingLevel("high");

    await session.compact();

    expect(seen).toEqual(["low"]);
  });

  it("falls back to the session level when no compaction override is set", async () => {
    const sessionManager = createThreeTurnSessionManager();
    const { seen, resourceLoader } = recordCompactionThinkingLevel(sessionManager);
    // testModel is non-reasoning, so "high" would clamp back to "off" there.
    const reasoningModel: Model = { ...testModel, id: "test-reasoning-model", reasoning: true };
    const { session } = await createTestSession({
      model: reasoningModel,
      sessionManager,
      resourceLoader,
    });
    await session.setThinkingLevel("high");

    await session.compact();

    expect(seen).toEqual(["high"]);
  });
});
