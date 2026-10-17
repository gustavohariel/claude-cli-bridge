import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSideConnection, PermissionOption, RequestPermissionResponse, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { takeCardAnswers } from "./card-answers.ts";
import { createDeferred, type Deferred } from "./deferred.ts";
import type { HookPayload, HookResponse } from "./hook-server.ts";
import { writeLog } from "./log.ts";
import {
  answerFromOption,
  answersForCards,
  questionCardOptions,
  questionCards,
  REPLY_IN_CHAT_OPTION_ID,
  type QuestionCard,
} from "./question-card.ts";

type PermissionSuggestion = Record<string, unknown>;

type PendingTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// An entry waits only for the PermissionRequest that follows its PreToolUse a moment later, and every entry is dropped at the start of a prompt.
// Claude works between prompts too — the turn a task notification wakes it for, the agents it launches there — and none of that is a prompt, so a session left to work holds one tool input per call it makes until its process stops.
const MAX_PENDING_TOOLS = 100;

type PermissionChoice = {
  response: RequestPermissionResponse;
  suggestion?: PermissionSuggestion;
};

type Consent = {
  id: string;
  title: string;
  details: Record<string, unknown>;
  accept: { optionId: string; name: string };
  decline: { optionId: string; name: string };
};

type InteractionOutcome =
  | { decision: "allow"; input: Record<string, unknown> }
  | { decision: "deny"; reason: string };

/**
 * Claude's own names for the two tools that ask a person something rather than the machine. They
 * ride out as the permission's `name`, which is what `plugins/claude-tty/server/question-cards.ts`
 * matches to give each one Paseo's card for it.
 */
const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";

/** Paseo's own id for approving a plan; the plugin publishes it with the `implement` intent. */
const IMPLEMENT_OPTION_ID = "implement";

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "execute",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  WebFetch: "fetch",
  WebSearch: "search",
  Write: "edit",
};

export class InteractionBridge {
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly connection: AgentSideConnection;
  private readonly pendingTools: PendingTool[] = [];
  private readonly pendingRequests = new Set<Deferred<RequestPermissionResponse>>();
  /**
   * The cards something is actually waiting on: Claude blocked in a hook, or blocked on a question it
   * drew in its own terminal. A card that only tells somebody something is not one of these -- see
   * `openRequest` -- and must not make a session look busy.
   */
  private readonly blockingRequests = new Set<Deferred<RequestPermissionResponse>>();
  private readonly liveInteractions = new Map<string, Promise<InteractionOutcome>>();
  private readonly autoAccept: () => Promise<boolean>;

  constructor(sessionId: string, cwd: string, connection: AgentSideConnection, autoAccept: () => Promise<boolean> = async () => false) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.connection = connection;
    this.autoAccept = autoAccept;
  }

  /** Something is waiting on a person: a card is open in Paseo and Claude is held up behind it. */
  get pending(): boolean {
    return this.blockingRequests.size > 0;
  }

  beginTurn(): void {
    this.pendingTools.length = 0;
    this.cancelPending();
  }

  cancelPending(): void {
    for (const pending of this.pendingRequests) pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pendingRequests.clear();
    this.blockingRequests.clear();
  }

  requestWorkspaceTrust(): Promise<boolean> {
    return this.requestConsent({
      id: "workspace-trust",
      title: "Is this a project you created or one you trust?",
      details: { effect: "Claude Code will remember this workspace as trusted." },
      accept: { optionId: "trust-workspace", name: "Yes, trust this folder" },
      decline: { optionId: "deny-workspace", name: "No, exit" },
    });
  }

  /**
   * The files are the whole of the question. "External imports" with nothing named is not something
   * anybody can say yes to -- what is being approved is a set of paths chosen by whoever wrote the
   * CLAUDE.md, read into Claude's context as instructions -- so they are read off Claude's own screen
   * and ride out in the card. The two options are worded as Claude words them, because the person
   * answering here is answering Claude's dialog through Paseo rather than a question of Paseo's own.
   */
  requestExternalImports(imports: string[]): Promise<boolean> {
    return this.requestConsent({
      id: "external-imports",
      title: "Let this project's CLAUDE.md import files from outside it?",
      details: {
        imports,
        warning: "An import is read into Claude's context as instructions, and these files sit outside the workspace, so nothing in this project says what they contain.",
        effect: "Declining leaves the imports out; the session starts either way.",
      },
      accept: { optionId: "allow-external-imports", name: "Yes, allow external imports" },
      decline: { optionId: "disable-external-imports", name: "No, disable external imports" },
    });
  }

  requestBypassPermissions(): Promise<boolean> {
    return this.requestConsent({
      id: "bypass-permissions",
      title: "Run Claude Code without asking permission for anything?",
      details: {
        warning: "In Bypass Permissions mode Claude Code runs every command, including destructive ones, without asking.",
        effect: "Claude Code will remember this answer for every session on this host, in every workspace.",
      },
      accept: { optionId: "accept-bypass", name: "Yes, I accept" },
      decline: { optionId: "deny-bypass", name: "No, exit" },
    });
  }

  async handlePreToolUse(payload: HookPayload): Promise<HookResponse> {
    const name = stringValue(payload.tool_name) || "Tool";
    const input = objectValue(payload.tool_input) || {};
    const toolUseId = stringValue(payload.tool_use_id) || `tool-${randomUUID()}`;
    if (this.pendingTools.length >= MAX_PENDING_TOOLS) this.pendingTools.shift();
    this.pendingTools.push({ id: toolUseId, name, input });
    const interaction = this.interactionFor(name, input, toolUseId);
    if (interaction) return preToolResponse(await interaction);
    return {};
  }

  async handlePermissionRequest(payload: HookPayload): Promise<HookResponse> {
    const name = stringValue(payload.tool_name) || "Tool";
    const input = objectValue(payload.tool_input) || {};
    const pending = this.takePendingTool(name, input);
    const toolCallId = pending?.id || `permission-${randomUUID()}`;
    const interaction = this.interactionFor(name, input, toolCallId);
    if (interaction) return permissionResponse(await interaction);
    // Asked here, per request, rather than when the session opened, so switching it on reaches a session
    // already working. It answers allow once and takes none of Claude's suggestions, so turning it off
    // again leaves no rule behind; the questions and plans above are for a person and never reach it.
    if (await this.autoAccept()) {
      writeLog({ level: "info", message: "Auto-accepted a permission request", sessionId: this.sessionId, tool: name, toolCallId });
      return permissionHookResponse({ response: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    }
    const suggestions = Array.isArray(payload.permission_suggestions)
      ? payload.permission_suggestions.filter((value): value is PermissionSuggestion => objectValue(value) !== null)
      : [];
    const suggestionByOption = new Map<string, PermissionSuggestion>();
    const options: PermissionOption[] = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }];
    for (let index = 0; index < suggestions.length; index += 1) {
      const optionId = `allow-suggestion-${index}`;
      suggestionByOption.set(optionId, suggestions[index]!);
      options.push({ optionId, name: suggestionLabel(suggestions[index]!), kind: "allow_always" });
    }
    options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
    const response = await this.request({
      toolCall: toolCall(toolCallId, name, input, this.cwd),
      options,
    });
    const choice: PermissionChoice = {
      response,
      ...(response.outcome.outcome === "selected" ? { suggestion: suggestionByOption.get(response.outcome.optionId) } : {}),
    };
    return permissionHookResponse(choice);
  }

  // Claude skips its permission pipeline only while the PreToolUse hook that renders these answers in time.
  // A hook that died leaves the pipeline to ask instead, so the same interaction serves both events: it reuses the card already on screen, or renders one here.
  // Rendering the tool again would show it as raw JSON, and that card's Allow leaves Claude waiting at its own dialog inside the PTY.
  private interactionFor(name: string, input: Record<string, unknown>, toolUseId: string): Promise<InteractionOutcome> | null {
    if (name === QUESTION_TOOL) return this.interaction(name, input, () => this.handleQuestions(toolUseId, input));
    if (name === PLAN_TOOL) return this.interaction(name, input, () => this.handlePlanApproval(toolUseId, input));
    return null;
  }

  private interaction(name: string, input: Record<string, unknown>, start: () => Promise<InteractionOutcome>): Promise<InteractionOutcome> {
    const key = `${name}:${JSON.stringify(input)}`;
    const live = this.liveInteractions.get(key);
    if (live) return live;
    const pending = start().finally(() => this.liveInteractions.delete(key));
    this.liveInteractions.set(key, pending);
    return pending;
  }

  /**
   * One card for the whole tool call, whatever it asks: the plugin republishes it as Paseo's own
   * question request, which renders every question at once with real radio groups, checkboxes for
   * `multiSelect` and a text box for an answer that is on none of the lists, and answers it in one
   * response. What comes back is the answers themselves, or a single option from a client that has
   * no such form, or nothing — and a card nobody answered is one Claude asks again in prose.
   */
  private async handleQuestions(toolUseId: string, input: Record<string, unknown>): Promise<InteractionOutcome> {
    const cards = questionCards(input);
    if (cards.length === 0) return { decision: "allow", input: { ...input, answers: {} } };
    const cardId = `${toolUseId}-questions`;
    const response = await this.request({
      toolCall: {
        toolCallId: cardId,
        // ACP has no field for the tool's own name, so the title carries it: it is what the bridge
        // reports as the permission's name, and the plugin matches on that to give this its card.
        title: QUESTION_TOOL,
        kind: "other",
        status: "pending",
        rawInput: input,
      },
      options: questionCardOptions(cards),
    });
    const answers = await this.questionCardAnswers(cardId, response, cards);
    const deferred = cards.filter((card) => answers[card.question] === undefined).map((card) => card.question);
    if (deferred.length > 0) return conversationalQuestionFallback(answers, deferred);
    return { decision: "allow", input: { ...input, answers } };
  }

  private async questionCardAnswers(
    cardId: string,
    response: RequestPermissionResponse,
    cards: QuestionCard[],
  ): Promise<Record<string, string>> {
    if (response.outcome.outcome === "cancelled" || response.outcome.optionId === REPLY_IN_CHAT_OPTION_ID) return {};
    const handedOff = await takeCardAnswers(cardId);
    if (handedOff) return answersForCards(handedOff, cards);
    return answerFromOption(response.outcome.optionId, cards) ?? {};
  }

  /**
   * Paseo's own plan vocabulary: the plugin turns this into a `kind: "plan"` request, whose card
   * renders the plan itself and offers Implement against Reject. There is no `implement_resume`
   * beside them, because the mode is a launch argument here and this session cannot change it.
   */
  private async handlePlanApproval(toolUseId: string, input: Record<string, unknown>): Promise<InteractionOutcome> {
    const response = await this.request({
      toolCall: {
        toolCallId: `${toolUseId}-approval`,
        title: PLAN_TOOL,
        kind: "switch_mode",
        status: "pending",
        rawInput: input,
      },
      options: [
        { optionId: IMPLEMENT_OPTION_ID, name: "Implement", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    if (response.outcome.outcome === "selected" && response.outcome.optionId === IMPLEMENT_OPTION_ID) return { decision: "allow", input };
    return { decision: "deny", reason: "The user did not approve leaving plan mode." };
  }

  /**
   * A card for a decision Claude asks for before a session runs, and keeps once it is answered.
   * Both options are declining ones because the answer outlives the session that raised it, and Paseo's automatic permission modes accept allow options without showing anybody a card.
   * The decline comes first because an answer carrying no action id, which is what `paseo permit deny` sends, takes the first option of its behaviour, and here that is either option.
   */
  private async requestConsent(consent: Consent): Promise<boolean> {
    const response = await this.request({
      toolCall: {
        toolCallId: `${consent.id}-${randomUUID()}`,
        title: consent.title,
        kind: "other",
        status: "pending",
        rawInput: { workspace: this.cwd, ...consent.details },
        locations: [{ path: this.cwd }],
      },
      options: [
        { ...consent.decline, kind: "reject_once" },
        { ...consent.accept, kind: "reject_once" },
      ],
    });
    return response.outcome.outcome === "selected" && response.outcome.optionId === consent.accept.optionId;
  }

  private request(params: { toolCall: ToolCallUpdate; options: PermissionOption[] }): Promise<RequestPermissionResponse> {
    return this.openRequest(params).response;
  }

  /**
   * The same card, with the handle that takes it back down again.
   *
   * Everything Claude asks through a hook is answered or it is not, and the hook is what ends it. A
   * question Claude draws in its own terminal is not like that: it can close while the card for it is
   * still up -- Claude times some of them out after 30 seconds, and a prompt arriving dismisses any of
   * them -- and the card then stands for a question nobody is asking. `withdraw` is how the caller
   * says so. It resolves this side as cancelled the way `cancelPending` does, and only this one rather
   * than every card at once; telling the client is the caller's, because ACP has no way to say it.
   *
   * `blocking: false` is for a card that only says something happened. Nothing is held up behind one --
   * Claude has already done the thing it is about -- so it must not read as a session somebody is still
   * answering for: that is what defers a suspension, and a card nobody clicks would defer it forever.
   */
  openRequest(
    params: { toolCall: ToolCallUpdate; options: PermissionOption[] },
    options: { blocking?: boolean } = {},
  ): {
    response: Promise<RequestPermissionResponse>;
    withdraw: () => void;
  } {
    const cancellation = createDeferred<RequestPermissionResponse>();
    this.pendingRequests.add(cancellation);
    if (options.blocking !== false) this.blockingRequests.add(cancellation);
    const response = Promise.race([
      this.connection.requestPermission({ sessionId: this.sessionId, ...params }),
      cancellation.promise,
    ]).finally(() => {
      this.pendingRequests.delete(cancellation);
      this.blockingRequests.delete(cancellation);
    });
    return {
      response,
      withdraw: () => cancellation.resolve({ outcome: { outcome: "cancelled" } }),
    };
  }

  private takePendingTool(name: string, input: Record<string, unknown>): PendingTool | null {
    const signature = JSON.stringify(input);
    const index = this.pendingTools.findLastIndex((tool) => tool.name === name && JSON.stringify(tool.input) === signature);
    if (index < 0) return null;
    return this.pendingTools.splice(index, 1)[0] || null;
  }
}

function permissionHookResponse(choice: PermissionChoice): HookResponse {
  const outcome = choice.response.outcome;
  if (outcome.outcome === "cancelled" || outcome.optionId === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: outcome.outcome === "cancelled" ? "The permission request was cancelled." : "The user denied this action.", interrupt: false },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", ...(choice.suggestion ? { updatedPermissions: [choice.suggestion] } : {}) },
    },
  };
}

function preToolResponse(outcome: InteractionOutcome): HookResponse {
  if (outcome.decision === "deny") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: outcome.reason } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: outcome.input } };
}

// The answers have to ride in as updatedInput here too, because Claude reads a bare allow for a tool that asks the user something as permission to run its own dialog, which in this PTY nobody can answer.
function permissionResponse(outcome: InteractionOutcome): HookResponse {
  if (outcome.decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: outcome.reason, interrupt: false },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: outcome.input },
    },
  };
}

function conversationalQuestionFallback(answers: Record<string, string> = {}, deferredQuestions: string[] = []): InteractionOutcome {
  const completed = Object.keys(answers).length > 0 ? ` Keep these completed answers: ${JSON.stringify(answers)}.` : "";
  const deferred = deferredQuestions.length > 0 ? ` Ask only these deferred questions: ${JSON.stringify(deferredQuestions)}.` : "";
  return {
    decision: "deny",
    reason: `The user left these questions to be asked in chat.${completed}${deferred} Restate the deferred questions conversationally in one message, then end this turn and wait for the user's response.`,
  };
}

function toolCall(id: string, name: string, input: Record<string, unknown>, cwd: string): ToolCallUpdate {
  const candidatePath = stringValue(input.file_path) || stringValue(input.path);
  const resolvedPath = candidatePath ? (path.isAbsolute(candidatePath) ? candidatePath : path.resolve(cwd, candidatePath)) : null;
  return {
    toolCallId: id,
    title: toolTitle(name, input),
    kind: TOOL_KINDS[name] || "other",
    status: "pending",
    rawInput: input,
    ...(resolvedPath ? { locations: [{ path: resolvedPath }] } : {}),
  };
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const detail = stringValue(input.description) || stringValue(input.command)?.split("\n")[0] || stringValue(input.file_path) || stringValue(input.query);
  return detail ? `${name}: ${detail}` : name;
}

function suggestionLabel(suggestion: PermissionSuggestion): string {
  const destination = stringValue(suggestion.destination);
  const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [];
  const firstRule = objectValue(rules[0]);
  const toolName = stringValue(firstRule?.toolName);
  const content = stringValue(firstRule?.ruleContent);
  const scope = destination === "userSettings" ? "globally" : destination === "projectSettings" ? "for this project" : "locally";
  return toolName ? `Always allow ${toolName}${content ? ` (${content})` : ""} ${scope}` : `Apply Claude's permission suggestion ${scope}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
