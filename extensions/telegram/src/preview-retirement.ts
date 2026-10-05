import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { listTelegramAccountIds } from "./accounts.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";

/**
 * Message ids are only meaningful across accounts in supergroups and channels
 * (`-100…` chat ids), where they come from the channel's own sequence.
 * Private and basic-group ids are account-local: the same numeric coordinates
 * in a sibling's cache can belong to an unrelated conversation, so fan-out
 * there would delete messages Telegram never asked us to touch.
 */
function chatSharesMessageIdentityAcrossAccounts(chatId: string | number): boolean {
  const id = String(chatId);
  return id.startsWith("-100") || id.startsWith("@");
}

/**
 * Retires one precisely identified streamed preview from the originating
 * account's message history, and from sibling accounts too when the chat
 * shares message identity across accounts. Telegram never delivers a message
 * deletion to other bots, so a sibling account's cache copy would otherwise
 * linger and keep feeding the dead preview text into later group history
 * windows.
 */
export async function retireTelegramStreamPreviewAcrossAccounts(params: {
  cfg: OpenClawConfig;
  originAccountId: string;
  chatId: string | number;
  messageId: string | number;
}): Promise<void> {
  const accountIds = chatSharesMessageIdentityAcrossAccounts(params.chatId)
    ? [...new Set([params.originAccountId, ...listTelegramAccountIds(params.cfg)])]
    : [params.originAccountId];
  await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const cache = createTelegramMessageCache({
          scope: resolveTelegramMessageCacheScope(
            resolveStorePath(params.cfg.session?.store, {
              agentId: resolveTelegramAccountOwnerAgentId({
                cfg: params.cfg,
                accountId,
              }),
            }),
          ),
        });
        await cache.retireMessage({
          accountId,
          chatId: params.chatId,
          messageId: params.messageId,
        });
      } catch (error) {
        logVerbose(
          `telegram: failed to retire stream preview for account ${accountId}: ${String(error)}`,
        );
      }
    }),
  );
}
