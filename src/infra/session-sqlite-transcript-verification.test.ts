import path from "node:path";
import { expect, it } from "vitest";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTranscriptEventReader } from "./session-sqlite-migration-readers.js";
import { verifyTranscriptEvents } from "./session-sqlite-transcript-verification.js";

it("accepts an imported legacy transcript whose message media was canonicalized on write", async () => {
  await withOpenClawTestState({ label: "verify-legacy-media" }, async (state) => {
    const sessionId = "legacy-media";
    const header = { type: "session", id: sessionId, version: 3 };
    const legacyMediaMessage = {
      type: "message",
      id: "m1",
      parentId: null,
      message: {
        role: "user",
        content: "see attached",
        MediaPath: "/tmp/photo.png",
        MediaType: "image",
      },
    };
    const filename = await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify(legacyMediaMessage)}\n`,
    );
    await importSqliteSessionRows({
      agentId: "main",
      env: state.env,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      entry: { sessionId, updatedAt: 1 },
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    try {
      const verified = verifyTranscriptEvents(
        database.db,
        { path: filename, sessionId, originalPath: filename },
        "contained",
      );
      expect(verified).toMatchObject({ events: 2, missingEvents: 0 });
    } finally {
      database.db.close();
    }
  });
});
