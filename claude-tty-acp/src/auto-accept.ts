import { readSettingsValues } from "./settings-document.ts";

/**
 * Paseo's own id for the toggle its built-in ACP provider shows, so the plugin provider's copy of it
 * reads as the same switch. The bridge turns a boolean config option into an agent feature of this id.
 */
export const AUTO_ACCEPT_CONFIG_ID = "auto_accept";

const BYPASS_MODE = "bypassPermissions";

/**
 * What a session nobody has switched does with a permission request.
 * A Bypass Permissions session uses `bypassAutoAccept` when it is a boolean, and everything else uses `autoAccept`.
 * Anything unreadable asks, because an approval is not something to guess at.
 */
export function autoAcceptDefault(values: Record<string, unknown> | null, mode: string): boolean {
  if (values === null) return false;
  if (mode === BYPASS_MODE && typeof values.bypassAutoAccept === "boolean") return values.bypassAutoAccept;
  return values.autoAccept === true;
}

/** Read per request rather than once, so a change made in Paseo reaches sessions that are already open. */
export async function readAutoAcceptDefault(mode: string, filePath?: string | null): Promise<boolean> {
  return autoAcceptDefault(await readSettingsValues(filePath), mode);
}
