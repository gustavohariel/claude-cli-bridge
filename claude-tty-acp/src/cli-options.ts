import { ANSWERS_DIRECTORY_FLAG } from "./card-answers.ts";
import { APP_NAME, APP_VERSION } from "./constants.ts";

export type CliAction =
  | { kind: "serve"; settingsFile: string | null; answersDirectory: string | null }
  | { kind: "print"; text: string }
  | { kind: "diagnose"; json: boolean };

const SETTINGS_FILE_FLAG = "--settings-file";

const HELP = `Usage: ${APP_NAME} [${SETTINGS_FILE_FLAG} <path>] [${ANSWERS_DIRECTORY_FLAG} <path>] [--help | --version | --diagnose [--json]]

Runs the interactive Claude Code ACP adapter over stdin/stdout.
Use ${SETTINGS_FILE_FLAG} to name a JSON file holding idleTimeoutMs, autoAccept and bypassAutoAccept; Paseo's Claude TTY plugin passes one it keeps in step with its settings screen.
Use ${ANSWERS_DIRECTORY_FLAG} to name the directory that plugin leaves question card answers in; without it a card can only be answered one option at a time.
Use --diagnose to check this host without starting ACP, and --json to get one machine-readable line instead of the report.
`;

export function parseCliArgs(args: string[]): CliAction {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "print", text: HELP };
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return { kind: "print", text: APP_VERSION };
  }
  if (args.length === 1 && args[0] === "--diagnose") return { kind: "diagnose", json: false };
  if (args.length === 2 && args.includes("--diagnose") && args.includes("--json")) return { kind: "diagnose", json: true };
  return serveAction(args);
}

/** Every serving flag names a path, and a path never starts with a dash, so a missing value reads as an unknown flag rather than as one. */
function serveAction(args: string[]): CliAction {
  const paths = new Map<string, string | null>([
    [SETTINGS_FILE_FLAG, null],
    [ANSWERS_DIRECTORY_FLAG, null],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    const known = paths.has(flag) && paths.get(flag) === null;
    if (!known || value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(`Unknown arguments: ${args.join(" ")}`);
    }
    paths.set(flag, value);
  }
  return {
    kind: "serve",
    settingsFile: paths.get(SETTINGS_FILE_FLAG) ?? null,
    answersDirectory: paths.get(ANSWERS_DIRECTORY_FLAG) ?? null,
  };
}
