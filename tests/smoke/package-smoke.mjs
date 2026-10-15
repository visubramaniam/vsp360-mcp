// Smoke test for an unpacked standalone package, run with any Node.js 20+ (CI uses the package's own runtime):
//
//   node tests/smoke/package-smoke.mjs <unpacked package folder> <expected version>
//
// It checks, against a mock VSP 360 on 127.0.0.1 (no real system is contacted):
// - the bundled runtime runs and reports its architecture
// - the server starts via `runtime/node dist/index.js` (the command INSTALL.md gives for MCP clients) and via
//   the bin/ launcher (`vsp360-mcp.cmd` on Windows), answers MCP initialize and tools/list with the right version
// - a call signs in, a save_to file and a binary download land in a download folder whose path has a space
// Exits non-zero, with a message, on the first failure.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [dir, expected] = process.argv.slice(2);
if (!dir || !expected) { console.error("usage: package-smoke.mjs <package folder> <expected version>"); process.exit(2); }
const windows = process.platform === "win32";
const node = join(dir, "runtime", windows ? "node.exe" : "node");
const launcher = join(dir, "bin", windows ? "vsp360-mcp.cmd" : "vsp360-mcp");
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`ok   ${msg}`);

for (const f of [node, launcher, join(dir, "dist", "index.js")]) if (!existsSync(f)) fail(`missing ${f}`);
const arch = spawnSync(node, ["-p", "process.platform + ' ' + process.arch + ' ' + process.version"], { encoding: "utf8" });
if (arch.status !== 0) fail(`bundled runtime didn't run: ${arch.stderr}`);
ok(`bundled runtime: ${arch.stdout.trim()}`);

// A mock VSP 360: the token endpoint, a JSON read, and a binary download.
let tokenRequests = 0;
const mock = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/v1/vsp360/auth/token") {
    tokenRequests++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "smoke", expires_in: 3600 }));
  } else if (req.url === "/api/v1/vsp360/about" && req.headers.authorization === "Bearer smoke") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ product: "VSP 360", version: "1.4" }));
  } else if (req.url.startsWith("/api/v1/vsp360/devices/inventory/download") && req.headers.authorization === "Bearer smoke") {
    res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="inventory.zip"' }).end(Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
// The mock is plain HTTP on loopback, so the server needs VSP360_ALLOW_HTTP=true to reach it.
const base = `http://127.0.0.1:${mock.address().port}`;

/** Runs one MCP session against the server started by `command`, returning the responses by id and stderr. */
function session(label, command, args, options, requests) {
  return new Promise((resolve) => {
    const downloads = mkdtempSync(join(tmpdir(), "vsp360 smoke "));
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, VSP360_URL: base, VSP360_ALLOW_HTTP: "true", VSP360_CLIENT_ID: "smoke", VSP360_CLIENT_SECRET: "smoke", VSP360_DOWNLOAD_DIR: downloads },
    });
    const responses = new Map();
    let out = "", err = "";
    const done = (why) => { clearTimeout(timer); child.kill(); resolve({ responses, err, downloads, why }); };
    const timer = setTimeout(() => done("timed out after 60 s"), 60_000);
    child.on("error", (e) => done(`could not start: ${e.message}`));
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => {
      out += d;
      for (let i; (i = out.indexOf("\n")) >= 0; ) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line) continue;
        try { const msg = JSON.parse(line); if (msg.id !== undefined) responses.set(msg.id, msg); } catch { /* not JSON-RPC */ }
        if (requests.every((r) => r.id === undefined || responses.has(r.id))) done();
      }
    });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
    console.log(`..   ${label}`);
  });
}

const call = (id, args) => ({ id, method: "tools/call", params: { name: "vsp360_call_operation", arguments: args } });
const requests = [
  { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } },
  { method: "notifications/initialized" },
  { id: 2, method: "tools/list" },
];

function check(label, { responses, err, why }) {
  if (why) fail(`${label}: ${why}\n${err}`);
  const version = responses.get(1)?.result?.serverInfo?.version;
  if (version !== expected) fail(`${label}: server reported version ${version}, expected ${expected}\n${err}`);
  const tools = (responses.get(2)?.result?.tools ?? []).map((t) => t.name);
  for (const t of ["vsp360_list_operations", "vsp360_describe_operation", "vsp360_call_operation"]) if (!tools.includes(t)) fail(`${label}: tool ${t} missing`);
  if (!/\[vsp360-mcp\] ready: 264 operations/.test(err)) fail(`${label}: no ready line on stderr\n${err}`);
  ok(`${label}: version ${version}, ${tools.length} tools, ready line`);
}

// 1. The command INSTALL.md gives MCP clients: the runtime with dist/index.js, plus a save_to file and a download.
const direct = await session("runtime + dist/index.js", node, [join(dir, "dist", "index.js")], {}, [
  ...requests,
  call(3, { operationId: "vsp360GetAbout", save_to: "about.json" }),
  call(4, { operationId: "vsp360GetDevicesInventoryDownload" }),
]);
check("runtime + dist/index.js", direct);
const text = (id) => direct.responses.get(id)?.result?.content?.map((c) => c.text).join("\n") ?? "";
if (direct.responses.get(3)?.result?.isError) fail(`save_to call failed: ${text(3)}`);
const saved = join(direct.downloads, "about.json");
if (!existsSync(saved) || JSON.parse(readFileSync(saved, "utf8")).version !== "1.4") fail(`save_to didn't write ${saved}: ${text(3)}`);
ok(`signed in (${tokenRequests} token request) and save_to wrote ${saved}`);
if (direct.responses.get(4)?.result?.isError) fail(`download call failed: ${text(4)}`);
const files = readdirSync(direct.downloads);
if (!files.includes("inventory.zip") || readFileSync(join(direct.downloads, "inventory.zip")).length !== 7) fail(`binary download not saved; folder has ${files.join(", ")}: ${text(4)}`);
ok(`binary download saved as ${join(direct.downloads, "inventory.zip")}`);

// 2. The bin/ launcher. A .cmd file needs a shell on Windows; the path is quoted because it may contain spaces.
const viaLauncher = windows
  ? await session("bin\\vsp360-mcp.cmd", `"${launcher}"`, [], { shell: true }, requests)
  : await session("bin/vsp360-mcp", launcher, [], {}, requests);
check(windows ? "bin\\vsp360-mcp.cmd" : "bin/vsp360-mcp", viaLauncher);

mock.close();
console.log(`PASS: ${dir}`);
