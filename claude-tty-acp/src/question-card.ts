import type { PermissionOption } from "@agentclientprotocol/sdk";

/**
 * The vocabulary of the one card an AskUserQuestion raises, mirrored by
 * `plugins/claude-tty/server/question-cards.ts`: the plugin republishes this permission as Paseo's
 * own `kind: "question"` request and answers it with these option ids. Keep the two copies in step.
 *
 * `SUBMIT_OPTION_ID` is first among the affirmative options on purpose. Paseo's question form sends
 * its answers with no action id at all, and the ACP bridge then resolves the first option whose
 * behaviour matches — so the option a bare "allow" lands on has to be the one that carries no
 * answer of its own.
 */
export const SUBMIT_OPTION_ID = "submit";
export const REPLY_IN_CHAT_OPTION_ID = "reply-in-chat";

export type QuestionCard = {
  question: string;
  labels: string[];
};

/** What Claude asked, reduced to what answering it needs; the plugin shapes the same array for the card. */
export function questionCards(input: Record<string, unknown>): QuestionCard[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((value) => {
    const question = objectValue(value);
    const text = stringValue(question?.question)?.trim();
    if (!question || !text) return [];
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = options.flatMap((option) => {
      const label = stringValue(objectValue(option)?.label)?.trim();
      return label ? [label] : [];
    });
    return [{ question: text, labels }];
  });
}

/** One id per answer a client can give without the question form: only offered while one question is on the card. */
export function answerOptionId(questionIndex: number, optionIndex: number): string {
  return `answer-${questionIndex}-${optionIndex}`;
}

/**
 * A client that renders the form answers through `updatedInput` and needs no option of its own; the
 * rest — a CLI, a notification, a host with no question form — get one button per answer, which only
 * says everything while there is a single question to answer.
 */
export function questionCardOptions(cards: QuestionCard[]): PermissionOption[] {
  const single = cards.length === 1 ? cards[0]! : null;
  return [
    { optionId: SUBMIT_OPTION_ID, name: "Submit answers", kind: "allow_once" },
    ...(single?.labels ?? []).map((label, index) => ({
      optionId: answerOptionId(0, index),
      name: label,
      kind: "allow_once" as const,
    })),
    { optionId: REPLY_IN_CHAT_OPTION_ID, name: "Answer in chat", kind: "reject_once" },
  ];
}

/** The answer a plain option stands for, or null when the option carries none. */
export function answerFromOption(optionId: string, cards: QuestionCard[]): Record<string, string> | null {
  const match = /^answer-(\d+)-(\d+)$/.exec(optionId);
  if (!match) return null;
  const card = cards[Number(match[1])];
  const label = card?.labels[Number(match[2])];
  return card && label ? { [card.question]: label } : null;
}

/** Only the answers that belong to questions Claude asked, so a stale or hostile document cannot invent one. */
export function answersForCards(answers: Record<string, unknown>, cards: QuestionCard[]): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const card of cards) {
    const answer = stringValue(answers[card.question])?.trim();
    if (answer) matched[card.question] = answer;
  }
  return matched;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
