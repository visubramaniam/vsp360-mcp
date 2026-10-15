// Checks the Claude plugin in plugin/: that it runs the server version its lockfile installs, that the lockfile
// meets the directory's rules (registry packages, exact versions, https, integrity hashes), and that it refers
// only to settings it declares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json"));
const deps = JSON.parse(read("plugin/package.json"));
const lock = JSON.parse(read("plugin/package-lock.json"));
const server = plugin.mcpServers.vsp360;

/** 0.1.20 → [0, 1, 20], for comparing versions without a semver library. */
const parts = (v) => v.split(".").map(Number);
const notNewer = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return true; };

test("the plugin runs the vsp360-mcp version its lockfile installs", () => {
  const version = deps.dependencies[pkg.name];
  assert.equal(plugin.version, version, "plugin.json version matches plugin/package.json's dependency");
  assert.equal(deps.version, version);
  assert.equal(lock.packages[`node_modules/${pkg.name}`].version, version, "the lockfile pins the same version");
  // The plugin follows releases: its lockfile can only name a version already on npm, so it may lag package.json.
  assert.ok(notNewer(version, pkg.version), `plugin version ${version} is not newer than package.json ${pkg.version}`);
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/node_modules/vsp360-mcp/dist/index.js"]);
});

test("the lockfile meets the directory's and Claude Code's install rules", () => {
  assert.ok([2, 3].includes(lock.lockfileVersion));
  assert.deepEqual(Object.keys(deps.dependencies), [pkg.name], "only the server is a direct dependency");
  assert.ok(/^\d+\.\d+\.\d+$/.test(deps.dependencies[pkg.name]), "the dependency is an exact version");
  for (const key of ["scripts", "overrides", "workspaces"]) assert.ok(!(key in deps), `plugin/package.json has no ${key}`);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${path} comes from the npm registry over https`);
    assert.match(entry.integrity ?? "", /^sha512-/, `${path} has an integrity hash`);
    assert.ok(!entry.hasInstallScript, `${path} needs no install script (Claude Code installs with --ignore-scripts)`);
  }
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
  // The listing icon: a square PNG of 512-2048 px under 2 MB, at the path the directory reads.
  const icon = readFileSync(new URL("../../plugin/.claude-plugin/icon.png", import.meta.url));
  assert.equal(icon.subarray(1, 4).toString(), "PNG");
  const [w, h] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.ok(w === h && w >= 512 && w <= 2048 && icon.length < 2 * 1024 * 1024, `icon is ${w}x${h}, ${icon.length} bytes`);
});
