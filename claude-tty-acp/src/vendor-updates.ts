import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { writeLog } from "./log.ts";

/**
 * The things Paseo can be told that ACP has no word for, sent on the channel the tool-call mirror
 * already uses: a vendor notification the bridge does not consume and `plugins/claude-tty/server`
 * picks up. A client that does not know the method ignores it, which is what both of Paseo's bridges
 * do with an extension they were not written for, so nothing here can break a session.
 *
 * Keep the method names in step with the plugin, which cannot import them: it runs in the daemon.
 */

/**
 * A line for the session's timeline: `session.notice` in Paseo's vocabulary, which is a notification
 * item rather than a message and does not send a push. What it is for here is the thing that happened
 * to the session rather than in the conversation -- a question dismissed to get a prompt in, a model
 * Claude switched underneath the session.
 */
export const NOTICE_METHOD = "_claude_tty/notice";

/**
 * A card this adapter raised and no longer wants an answer to. ACP has no way to take a permission
 * request back -- the agent asks and waits, and only the client ever ends one -- so the plugin
 * resolves it on the daemon's side instead. Without this a question that closed by itself would leave
 * a card on screen that answers nothing.
 */
export const CARD_WITHDRAWN_METHOD = "_claude_tty/card_withdrawn";

/**
 * The model Claude is actually answering on, where that is no longer the one the session was launched
 * with. ACP carries a session's mode back to the client and nothing else about its configuration --
 * there is no `current_model_update` beside `current_mode_update` -- so a model Claude swapped for
 * itself has no way home. The plugin puts it in the picker by re-emitting the session's configuration
 * with this in it, which is a reading rather than a decision: nothing here re-launches Claude, so the
 * flag the session was started with is untouched and a restart goes back to it.
 */
export const MODEL_CHANGED_METHOD = "_claude_tty/model";

export type VendorNotice = {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  description?: string;
};

export async function sendNotice(connection: AgentSideConnection, sessionId: string, notice: VendorNotice): Promise<void> {
  await send(connection, sessionId, NOTICE_METHOD, { sessionId, notice });
}

export async function sendModelChanged(connection: AgentSideConnection, sessionId: string, model: string): Promise<void> {
  await send(connection, sessionId, MODEL_CHANGED_METHOD, { sessionId, model });
}

export async function sendCardWithdrawn(connection: AgentSideConnection, sessionId: string, toolCallId: string): Promise<void> {
  await send(connection, sessionId, CARD_WITHDRAWN_METHOD, { sessionId, toolCallId });
}

/**
 * Nothing sent here is worth an exception. These are extras on top of a session that works without
 * them, and the callers are a poll tick and the path that delivers a prompt -- neither of which should
 * fail because a host is on a bridge that has never heard of this method.
 */
async function send(connection: AgentSideConnection, sessionId: string, method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await connection.extNotification(method, params);
  } catch (error) {
    writeLog({
      level: "warn",
      message: "Could not send a vendor update to the client",
      sessionId,
      method,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
