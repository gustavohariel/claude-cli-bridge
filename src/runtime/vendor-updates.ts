import type { AgentSideConnection } from "./protocol.ts";
import { writeLog } from "./log.ts";

/**
 * The things the runtime can tell its client that session updates have no word for, sent as vendor
 * notifications. A client that does not know a method ignores it (the bridge ignores all of them),
 * so nothing here can break a session.
 */

/**
 * A line for the session's timeline: `session.notice` in the client's vocabulary, which is a notification
 * item rather than a message and does not send a push. What it is for here is the thing that happened
 * to the session rather than in the conversation -- a question dismissed to get a prompt in, a model
 * Claude switched underneath the session.
 */
export const NOTICE_METHOD = "_claude_cli_bridge/notice";

/**
 * A card the runtime raised and no longer wants an answer to. A permission request cannot be taken
 * back -- the runtime asks and waits, and only the client ever ends one -- so this tells the client to
 * close it. Without it a question that closed by itself would leave a card on screen that answers nothing.
 */
export const CARD_WITHDRAWN_METHOD = "_claude_cli_bridge/card_withdrawn";

/**
 * The model Claude is actually answering on, where that is no longer the one the session was launched
 * with. The protocol carries a session's mode back to the client and nothing else about its configuration --
 * there is no `current_model_update` beside `current_mode_update` -- so a model Claude swapped for
 * itself has no way home but this. It is a reading rather than a decision: nothing here re-launches
 * Claude, so the flag the session was started with is untouched and a restart goes back to it.
 */
export const MODEL_CHANGED_METHOD = "_claude_cli_bridge/model";

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
