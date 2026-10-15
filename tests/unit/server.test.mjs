// End-to-end tests of the MCP server over stdio. The server is pointed at an address that does not exist, so
// any call that got past the server's own checks would fail with a network error rather than reach a system.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Spec, isMultipart } from "../../dist/spec.js";

const SERVER = new URL("../../dist/index.js", import.meta.url).pathname;
const spec = new Spec(new URL("../../spec/Platform-vsp360-openapi.yaml", import.meta.url).pathname);
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const open = [];

async function server(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH, VSP360_URL: "https://vsp360.invalid", VSP360_CLIENT_ID: "x", VSP360_CLIENT_SECRET: "x", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "unit-test", version: "1" });
  await client.connect(transport);
  open.push(client);
  return client;
}
after(async () => { for (const c of open) await c.close(); });

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("reports the package version", async () => {
  const c = await server();
  assert.equal(c.getServerVersion().version, version);
});

test("read-only mode refuses every write operation before any request is made", async () => {
  const c = await server();
  const writes = [...spec.operations.values()].filter((o) => !o.readOnly);
  assert.equal(writes.length, 124);
  for (const op of writes) {
    const r = await c.callTool({ name: "vsp360_call_operation", arguments: { operationId: op.operationId } });
    assert.ok(r.isError, op.operationId);
    assert.match(textOf(r), /server is running read-only/, op.operationId);
  }
});

test("the secret read is refused unless VSP360_ALLOW_SECRET_READS is set", async () => {
  const c = await server({ VSP360_ALLOW_WRITES: "true" });
  const r = await c.callTool({ name: "vsp360_call_operation", arguments: { operationId: "vsp360GetServiceAccountSecret", params: { serviceAccountId: "a" } } });
  assert.ok(r.isError);
  assert.match(textOf(r), /VSP360_ALLOW_SECRET_READS/);
  const d = await c.callTool({ name: "vsp360_describe_operation", arguments: { operationId: "vsp360GetServiceAccountSecret" } });
  assert.match(textOf(d), /returns a secret \(blocked/);
});

test("read-only mode refuses uploads unless VSP360_UPLOAD_DIR is set", async () => {
  const id = "vsp360PostDevicesEnrollmentTemplateValidate";
  const args = { operationId: id, params: { deviceType: "Storage" }, files: { file: SERVER } };
  const ro = await server();
  const r1 = await ro.callTool({ name: "vsp360_call_operation", arguments: args });
  assert.ok(r1.isError);
  assert.match(textOf(r1), /read-only mode allows only from VSP360_UPLOAD_DIR/);
  assert.match(textOf(await ro.callTool({ name: "vsp360_describe_operation", arguments: { operationId: id } })), /uploads a file \(blocked/);

  // With the folder set, the call gets past the gate and the client confines the file to that folder.
  const dir = mkdtempSync(join(tmpdir(), "vsp360-uploads-"));
  const scoped = await server({ VSP360_UPLOAD_DIR: dir });
  assert.match(textOf(await scoped.callTool({ name: "vsp360_call_operation", arguments: args })), /outside VSP360_UPLOAD_DIR/);

  // With writes allowed, uploads follow the usual rules.
  const rw = await server({ VSP360_ALLOW_WRITES: "true" });
  assert.doesNotMatch(textOf(await rw.callTool({ name: "vsp360_call_operation", arguments: args })), /VSP360_UPLOAD_DIR/);
});

test("a HIGH-confidence search lists the top result's parameters, unless that operation is blocked", async () => {
  const c = await server();
  const search = async (query) => textOf(await c.callTool({ name: "vsp360_list_operations", arguments: { query } }));
  const alerts = await search("show current platform alerts");
  assert.match(alerts, /^Confidence: HIGH/);
  assert.match(alerts, /Parameters of vsp360GetAlerts:\n- active \(query, optional\): boolean/);
  assert.match(await search("download device inventory csv"), /- tab \(query, optional\): "all"\|"block"/, "enums list their values");
  const snapshot = await search("take a snapshot now outside the schedule");
  assert.match(snapshot, /^Confidence: HIGH/);
  assert.doesNotMatch(snapshot, /Parameters of/, "a write blocked in read-only mode gets no parameters");
  assert.doesNotMatch(await search("list registered devices"), /Parameters of/, "only HIGH confidence");
});

test("describe returns compact JSON", async () => {
  const c = await server();
  const d = textOf(await c.callTool({ name: "vsp360_describe_operation", arguments: { operationId: "vsp360GetAbout" } }));
  assert.ok(!d.includes("\n  "), "no indentation");
  assert.equal(JSON.parse(d).operationId, "vsp360GetAbout");
});

test("direct tools exclude writes and the secret read in read-only mode, and all names are valid", async () => {
  const c = await server({ VSP360_TOOLSETS: "all" });
  const { tools } = await c.listTools();
  const direct = tools.filter((t) => !t.name.startsWith("vsp360_"));
  // The read-only upload is excluded too, because VSP360_UPLOAD_DIR is not set.
  const readable = [...spec.operations.values()].filter((o) => o.readOnly && !o.secret && !isMultipart(o));
  assert.equal(direct.length, readable.length);
  assert.ok(!direct.some((t) => t.name === "vsp360PostDevicesEnrollmentTemplateValidate"));
  for (const t of tools) {
    assert.match(t.name, /^[A-Za-z0-9_.-]{1,64}$/);
    for (const p of Object.keys(t.inputSchema.properties ?? {})) assert.match(p, /^[A-Za-z0-9_.-]{1,64}$/, `${t.name}.${p}`);
  }
  const call = await c.callTool({ name: "vsp360PostDevicesEnroll", arguments: {} });
  assert.match(textOf(call), /Unknown tool/);
});

test("with writes allowed, every operation except the secret read is a direct tool", async () => {
  const c = await server({ VSP360_TOOLSETS: "all", VSP360_ALLOW_WRITES: "true" });
  const { tools } = await c.listTools();
  assert.equal(tools.length, 3 + 263);
});

test("arguments of the wrong type return a result, not a crash", async () => {
  const c = await server();
  const r1 = await c.callTool({ name: "vsp360_list_operations", arguments: { tag: 123 } });
  assert.match(textOf(r1), /No operations in that area/);
  const r2 = await c.callTool({ name: "vsp360_list_operations", arguments: { query: "alerts", limit: "abc" } });
  assert.match(textOf(r2), /^Confidence:/);
  const r3 = await c.callTool({ name: "vsp360_describe_operation", arguments: { operationId: { x: 1 } } });
  assert.ok(r3.isError);
  assert.match(textOf(r3), /Unknown operationId/);
});
