// Checks the Claude plugin in plugin/ against the package it runs, so a release can't ship a plugin that
// pins an old server version or refers to settings it doesn't declare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json"));
const server = plugin.mcpServers.vsp360;

test("the plugin's version and pinned server version match package.json", () => {
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(server.args, ["-y", `${pkg.name}@${pkg.version}`]);
});

test("every ${user_config.*} reference is declared, and the secret is sensitive", () => {
  const refs = [...JSON.stringify(server).matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1]);
  for (const key of refs) assert.ok(plugin.userConfig[key], `userConfig.${key} is declared`);
  assert.equal(plugin.userConfig.client_secret.sensitive, true);
  for (const [key, opt] of Object.entries(plugin.userConfig)) {
    if (!opt.required) assert.ok("default" in opt, `optional userConfig.${key} has a default, so Cowork can start the server`);
  }
});

test("the plugin folder has what the directory requires", () => {
  const words = read("plugin/README.md").replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 40, "README has at least 40 words outside code blocks");
  assert.ok(existsSync(new URL("../../plugin/LICENSE", import.meta.url)));
  assert.match(plugin.name, /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);
});
