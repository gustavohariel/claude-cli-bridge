import { open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AvailableCommand } from "@agentclientprotocol/sdk";

const FRONTMATTER_BYTES = 8 * 1024;
const MAX_DEPTH = 4;
const MAX_PROJECT_LEVELS = 12;

type Command = AvailableCommand & { source: "builtin" | "user" | "project" | "plugin" };

export async function discoverCommands(cwd: string, configDir = claudeConfigDirectory()): Promise<AvailableCommand[]> {
  const projects = await projectDirectories(cwd);
  const layers: Command[][] = [
    await skillsIn(path.join(configDir, "skills"), "user"),
    ...(await Promise.all(projects.map((directory) => skillsIn(path.join(directory, ".claude", "skills"), "project")))),
    await commandsIn(path.join(configDir, "commands"), "user"),
    ...(await Promise.all(projects.map((directory) => commandsIn(path.join(directory, ".claude", "commands"), "project")))),
  ];
  for (const plugin of await installedPlugins(cwd, configDir)) {
    layers.push(await skillsIn(path.join(plugin.installPath, "skills"), "plugin", plugin.name));
    layers.push(await commandsIn(path.join(plugin.installPath, "commands"), "plugin", plugin.name));
    const root = await frontmatter(path.join(plugin.installPath, "SKILL.md"));
    if (root.name || root.description) {
      layers.push([{ name: `${plugin.name}:${root.name ?? path.basename(plugin.installPath)}`, description: root.description ?? "", source: "plugin", input: { hint: "arguments" } }]);
    }
  }
  const byName = new Map<string, AvailableCommand>();
  for (const command of [
    ...layers.flat(),
    { name: "clear", description: "Clear conversation history and start a new session", source: "builtin" as const },
    { name: "compact", description: "Summarize the conversation and reduce context usage", source: "builtin" as const },
  ]) {
    if (!byName.has(command.name)) byName.set(command.name, { name: command.name, description: command.description, input: command.input });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) values[field[1]!] = field[2]!.trim().replace(/^["'](.*)["']$/, "$1");
  }
  return values;
}

async function frontmatter(file: string): Promise<Record<string, string>> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseFrontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function skillsIn(directory: string, source: Command["source"], namespace?: string, depth = 0): Promise<Command[]> {
  if (depth >= MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: Command[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDirectory = path.join(directory, entry.name);
    const file = path.join(skillDirectory, "SKILL.md");
    if (!(await stat(file).catch(() => null))?.isFile()) {
      result.push(...(await skillsIn(skillDirectory, source, namespace, depth + 1)));
      continue;
    }
    const values = await frontmatter(file);
    const localName = namespace ? (values.name ?? entry.name) : entry.name;
    result.push({ name: namespace ? `${namespace}:${localName}` : localName, description: values.description ?? "", source, input: { hint: "arguments" } });
  }
  return result;
}

async function commandsIn(directory: string, source: Command["source"], namespace?: string): Promise<Command[]> {
  const result: Command[] = [];
  for (const file of await markdownFiles(directory)) {
    const values = await frontmatter(file);
    const localName = path.basename(file, ".md");
    result.push({ name: namespace ? `${namespace}:${localName}` : localName, description: values.description ?? "", source, input: { hint: values["argument-hint"] ?? "arguments" } });
  }
  return result;
}

async function markdownFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth >= MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) result.push(target);
    else if (entry.isDirectory()) result.push(...(await markdownFiles(target, depth + 1)));
  }
  return result;
}

async function projectDirectories(cwd: string): Promise<string[]> {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  for (let level = 0; level < MAX_PROJECT_LEVELS; level += 1) {
    directories.push(current);
    if (await stat(path.join(current, ".git")).catch(() => null)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

async function installedPlugins(cwd: string, configDir: string): Promise<Array<{ name: string; installPath: string }>> {
  const [enabled, installed] = await Promise.all([
    enabledPlugins(cwd, configDir),
    readJson(path.join(configDir, "plugins", "installed_plugins.json")),
  ]);
  const plugins = asRecord(installed)?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const result: Array<{ name: string; installPath: string }> = [];
  for (const [key, value] of Object.entries(plugins)) {
    if (!enabled.has(key) || !Array.isArray(value)) continue;
    const installPath = asRecord(value.at(-1))?.installPath;
    if (typeof installPath === "string") result.push({ name: key.split("@")[0]!, installPath });
  }
  return result;
}

async function enabledPlugins(cwd: string, configDir: string): Promise<Set<string>> {
  const enabled = new Set<string>();
  const files = await Promise.all([
    readJson(path.join(configDir, "settings.json")),
    readJson(path.join(cwd, ".claude", "settings.json")),
    readJson(path.join(cwd, ".claude", "settings.local.json")),
  ]);
  for (const file of files) {
    const plugins = asRecord(asRecord(file)?.enabledPlugins);
    if (!plugins) continue;
    for (const [name, value] of Object.entries(plugins)) {
      if (value === true) enabled.add(name);
      else enabled.delete(name);
    }
  }
  return enabled;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(process.env.HOME ?? os.homedir(), ".claude");
}
