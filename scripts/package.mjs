#!/usr/bin/env node
// Builds the release packages into release/ from an already-built dist/ (run `npm run package`):
//
//   vsp360-mcp-<version>.tgz                    npm package: `npm install -g <file or URL>` (needs Node.js 20+)
//   vsp360-mcp-<version>.mcpb                   Claude Desktop extension: double-click to install
//   vsp360-mcp-<version>-<platform>.tar.gz|zip  standalone: the server plus a Node.js runtime, nothing to install
//   SHA256SUMS                                  checksums of the files above
//
// Options:
//   --only npm,mcpb,standalone   build only these kinds (default: all)
//   --targets linux-x64,...      standalone platforms (default: all in TARGETS)
// NODE_RUNTIME_VERSION overrides the Node.js version bundled in the standalone packages.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const stage = join(out, ".stage");
const cache = join(out, ".cache");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const NODE_VERSION = process.env.NODE_RUNTIME_VERSION || "24.21.0";
// Node.js release signing keys (github.com/nodejs/release-keys), pinned to a commit. If a release of NODE_VERSION
// fails its signature check because a new releaser signed it, move this to a newer commit of that repository.
const NODE_KEYRING = "https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx";
// The Claude Desktop extension packer, run with npx at build time.
const MCPB = "@anthropic-ai/mcpb@2.1.2";

// Standalone platforms, named as Node.js names its downloads.
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win-x64", "win-arm64"];
// Files copied into every package besides dist/ and spec/.
const APP_FILES = ["package.json", "package-lock.json", "LICENSE", "README.md", "INSTALL.md", "CHANGELOG.md"];

const { values: opts } = parseArgs({
  options: { only: { type: "string", default: "npm,mcpb,standalone" }, targets: { type: "string", default: TARGETS.join(",") } },
});
const kinds = new Set(opts.only.split(","));
const targets = opts.targets.split(",");
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`Unknown target ${t}; expected one of ${TARGETS.join(", ")}`);

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
const log = (msg) => console.log(`[package] ${msg}`);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (!existsSync(join(root, "dist", "index.js"))) throw new Error("dist/index.js is missing; run `npm run build` first");

// Keep the download cache, replace everything else.
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (name !== ".cache") rmSync(join(out, name), { recursive: true, force: true });

/** dist/, spec/, the files above and production node_modules, as the server runs them. */
function stageApp() {
  const app = join(stage, "app");
  mkdirSync(app, { recursive: true });
  for (const f of APP_FILES) copyFileSync(join(root, f), join(app, f));
  cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
  cpSync(join(root, "spec"), join(app, "spec"), { recursive: true });
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], app);
  return app;
}

function buildNpm() {
  log("npm package");
  run("npm", ["pack", "--pack-destination", out, "--loglevel=error"]);
}

function buildMcpb(app) {
  log("Claude Desktop extension");
  const dir = join(stage, "mcpb");
  cpSync(app, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, "packaging", "mcpb", "manifest.json"), "utf8"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  // mcpb runs through npx, pinned, rather than as a dev dependency: its own dependencies (node-forge for signing,
  // tmp for interactive prompts) have security advisories, and `mcpb pack` uses neither.
  run("npx", ["--yes", MCPB, "pack", dir, join(out, `vsp360-mcp-${version}.mcpb`)]);
}

const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function hasGpgv() {
  try {
    execFileSync("gpgv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let nodeSumsLoaded;
/** The Node.js release's SHASUMS256.txt, with its signature checked against the Node.js release keys. */
const nodeSums = () => (nodeSumsLoaded ??= loadNodeSums());
async function loadNodeSums() {
  const sums = await download(`${NODE_BASE}/SHASUMS256.txt`);
  if (!hasGpgv()) {
    // CI must check it; a local build without GnuPG only warns.
    if (process.env.CI) throw new Error("gpgv (GnuPG) is needed to check the signature of the Node.js release's SHASUMS256.txt");
    log("warning: gpgv not found, so the signature of the Node.js release's SHASUMS256.txt is not checked; install GnuPG to check it");
    return sums.toString();
  }
  const dir = join(cache, `node-v${NODE_VERSION}-signature`);
  mkdirSync(dir, { recursive: true });
  const [sumsFile, sigFile, keyring] = ["SHASUMS256.txt", "SHASUMS256.txt.sig", "pubring.kbx"].map((f) => join(dir, f));
  writeFileSync(sumsFile, sums);
  writeFileSync(sigFile, await download(`${NODE_BASE}/SHASUMS256.txt.sig`));
  writeFileSync(keyring, await download(NODE_KEYRING));
  try {
    execFileSync("gpgv", ["--keyring", keyring, sigFile, sumsFile], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`The Node.js ${NODE_VERSION} SHASUMS256.txt failed its signature check:\n${e.stderr}`);
  }
  log(`Node.js ${NODE_VERSION} SHASUMS256.txt: signature verified`);
  return sums.toString();
}

/** Downloads a Node.js release archive once and checks it against the release's signed SHASUMS256.txt. */
async function nodeArchive(target) {
  const file = `node-v${NODE_VERSION}-${target}.${target.startsWith("win") ? "zip" : "tar.gz"}`;
  const path = join(cache, file);
  const base = NODE_BASE;
  const sums = await nodeSums();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
  if (!expected) throw new Error(`${file} is not listed in ${base}/SHASUMS256.txt`);
  if (!existsSync(path) || sha256(path) !== expected) {
    log(`downloading ${file}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(path, await download(`${base}/${file}`));
    if (sha256(path) !== expected) throw new Error(`${file} does not match its published SHA-256`);
  }
  return { path, top: file.replace(/\.(zip|tar\.gz)$/, "") };
}

const UNIX_LAUNCHER = `#!/bin/sh
# Starts vsp360-mcp with the Node.js runtime bundled next to it. Works through symlinks,
# e.g. ln -s /opt/vsp360-mcp/bin/vsp360-mcp /usr/local/bin/vsp360-mcp
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
here=$(cd "$(dirname "$self")/.." && pwd)
exec "$here/runtime/node" "$here/dist/index.js" "$@"
`;

const WINDOWS_LAUNCHER = `@echo off\r
rem Starts vsp360-mcp with the Node.js runtime bundled next to it.\r
"%~dp0..\\runtime\\node.exe" "%~dp0..\\dist\\index.js" %*\r
`;

async function buildStandalone(app, target) {
  log(`standalone ${target} (Node.js ${NODE_VERSION})`);
  const windows = target.startsWith("win");
  const name = `vsp360-mcp-${version}-${target}`;
  const dir = join(stage, name);
  cpSync(app, dir, { recursive: true });
  mkdirSync(join(dir, "runtime"));
  mkdirSync(join(dir, "bin"));

  const { path, top } = await nodeArchive(target);
  const tmp = join(stage, `node-${target}`);
  mkdirSync(tmp);
  const exe = windows ? "node.exe" : "node";
  if (windows) run("unzip", ["-q", path, `${top}/node.exe`, `${top}/LICENSE`, "-d", tmp]);
  else run("tar", ["-xzf", path, "-C", tmp, `${top}/bin/node`, `${top}/LICENSE`]);
  copyFileSync(join(tmp, top, windows ? "" : "bin", exe), join(dir, "runtime", exe));
  copyFileSync(join(tmp, top, "LICENSE"), join(dir, "runtime", "LICENSE"));
  chmodSync(join(dir, "runtime", exe), 0o755);

  if (windows) {
    writeFileSync(join(dir, "bin", "vsp360-mcp.cmd"), WINDOWS_LAUNCHER);
    run("zip", ["-qr", join(out, `${name}.zip`), name], stage);
  } else {
    writeFileSync(join(dir, "bin", "vsp360-mcp"), UNIX_LAUNCHER);
    chmodSync(join(dir, "bin", "vsp360-mcp"), 0o755);
    // macOS tar would otherwise store extended attributes that GNU tar warns about on every file.
    const noXattrs = process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : [];
    run("tar", [...noXattrs, "-czf", join(out, `${name}.tar.gz`), "-C", stage, name]);
  }
}

if (kinds.has("npm")) buildNpm();
if (kinds.has("mcpb") || kinds.has("standalone")) {
  const app = stageApp();
  if (kinds.has("mcpb")) buildMcpb(app);
  if (kinds.has("standalone")) for (const t of targets) await buildStandalone(app, t);
}
rmSync(stage, { recursive: true, force: true });

const files = readdirSync(out).filter((f) => !f.startsWith(".") && statSync(join(out, f)).isFile()).sort();
writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${sha256(join(out, f))}  ${f}\n`).join(""));
for (const f of files) log(`release/${f}  ${(statSync(join(out, f)).size / 1e6).toFixed(1)} MB`);
