import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverCommands, parseFrontmatter } from "./commands.ts";

test("discovers user, project, enabled-plugin, and clear commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-command-test-"));
  const config = path.join(root, "config");
  const cwd = path.join(root, "project");
  const plugin = path.join(root, "plugin");
  try {
    await Promise.all([
      mkdir(path.join(config, "commands"), { recursive: true }),
      mkdir(path.join(cwd, ".git"), { recursive: true }),
      mkdir(path.join(cwd, ".claude", "skills", "review"), { recursive: true }),
      mkdir(path.join(plugin, "commands"), { recursive: true }),
      mkdir(path.join(config, "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(config, "commands", "personal.md"), "---\ndescription: Personal command\n---\n"),
      writeFile(path.join(cwd, ".claude", "skills", "review", "SKILL.md"), "---\ndescription: Review changes\n---\n"),
      writeFile(path.join(plugin, "commands", "deploy.md"), "---\ndescription: Deploy it\n---\n"),
      writeFile(path.join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "ops@market": true } })),
      writeFile(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "ops@market": [{ installPath: plugin }] } })),
    ]);

    const commands = await discoverCommands(cwd, config);
    assert.deepEqual(commands.map((command) => command.name), ["clear", "compact", "ops:deploy", "personal", "review"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("parses quoted scalar frontmatter", () => {
  assert.deepEqual(parseFrontmatter("---\nname: example\ndescription: 'Do a thing'\n---\nbody"), { name: "example", description: "Do a thing" });
});
