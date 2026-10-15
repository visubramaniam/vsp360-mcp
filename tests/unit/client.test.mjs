// Unit tests for the HTTP client, against undici's MockAgent: nothing reaches the network.
// Run with `npm test` (builds first), or `node --test tests/unit/` after `npm run build`.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { Spec } from "../../dist/spec.js";
import { Vsp360Client, loadConfig } from "../../dist/client.js";

const BASE = "https://vsp.test";
const spec = new Spec(new URL("../../spec/vsp360-openapi.yaml", import.meta.url).pathname);
const op = (id) => spec.operations.get(id);

let dir, mock, pool, client, tokenRequests;

function makeClient(extra = {}) {
  const c = new Vsp360Client(loadConfig({ VSP360_URL: BASE, VSP360_CLIENT_ID: "id", VSP360_CLIENT_SECRET: "secret", VSP360_DOWNLOAD_DIR: join(dir, "downloads"), ...extra }));
  c.agent = mock; // private in TypeScript, reachable from tests
  return c;
}

/** Answers token requests, counting them. */
function tokens(times = 10, ttl = 3600) {
  pool.intercept({ path: "/api/v1/vsp360/auth/token", method: "POST" }).reply(() => {
    tokenRequests++;
    return { statusCode: 200, data: JSON.stringify({ access_token: `t${tokenRequests}`, expires_in: ttl }), responseOptions: { headers: { "content-type": "application/json" } } };
  }).times(times);
}

const json = (data, headers = {}) => ({ headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vsp360-client-"));
  mock = new MockAgent();
  mock.disableNetConnect();
  pool = mock.get(BASE);
  tokenRequests = 0;
  client = makeClient();
});
afterEach(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent first calls share one token request", async () => {
  tokens();
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(200, "{}", json()).times(5);
  const results = await Promise.all(Array.from({ length: 5 }, () => client.call(op("vsp360GetAbout"), {})));
  assert.ok(results.every((r) => r.ok));
  assert.equal(tokenRequests, 1);
});

test("a 401 refreshes the token once and retries", async () => {
  tokens();
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(200, "{}", json());
  await client.call(op("vsp360GetAbout"), {});
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(401, "expired");
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(200, '{"version":"1.4"}', json());
  const r = await client.call(op("vsp360GetAbout"), {});
  assert.ok(r.ok, r.text);
  assert.match(r.text, /1\.4/);
  assert.equal(tokenRequests, 2);
});

test("URL building: tool-safe aliases, required and unknown parameters, path rewrites", async () => {
  tokens();
  pool.intercept({ path: (p) => p.startsWith("/api/v1/vsp360/metrics/labels?"), method: "GET" }).reply((opts) => ({ statusCode: 200, data: JSON.stringify({ path: opts.path }), responseOptions: json() }));
  const labels = await client.call(op("vsp360GetMetricsLabels"), { params: { match: ["up", "down"] } });
  assert.match(labels.text, /match%5B%5D=up&match%5B%5D=down/, "match is sent as match[]");

  const unknown = await client.call(op("vsp360GetAbout"), { params: { nope: 1 } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /Unknown parameter\(s\).*nope/);

  const missing = await client.call(op("vsp360GetDiagnosticsJobsByIdDownload"), { params: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /Missing required path parameter "id"/);

  pool.intercept({ path: "/dataprotection/api/v1/protection/copies?limit=1", method: "GET" }).reply(200, "[]", json());
  const copies = await client.call(op("protectionListCopies"), { params: { limit: 1 } });
  assert.ok(copies.ok, "Data Protection paths are rewritten to /dataprotection");
});

function pages(n, { badPage } = {}) {
  for (let i = 0; i < n; i++) {
    const next = i < n - 1 ? { link: `<${BASE}/api/v1/vsp360/users?offset=${(i + 1) * 2}>; rel="next"` } : {};
    const path = i === 0 ? "/api/v1/vsp360/users" : `/api/v1/vsp360/users?offset=${i * 2}`;
    if (i === badPage) pool.intercept({ path, method: "GET" }).reply(200, "<html>gateway error</html>", { headers: { "content-type": "text/html", ...next } });
    else pool.intercept({ path, method: "GET" }).reply(200, JSON.stringify([{ id: i * 2 }, { id: i * 2 + 1 }]), json(null, next));
  }
}

test("all_pages follows next links and concatenates", async () => {
  tokens();
  pages(3);
  const r = await client.call(op("vsp360ListIdentityUsers"), { all_pages: true });
  assert.ok(r.ok);
  assert.match(r.text, /^6 items from 3 page\(s\)/);
});

test("all_pages stops at max_pages with a note", async () => {
  tokens();
  pages(3);
  const r = await client.call(op("vsp360ListIdentityUsers"), { all_pages: true, max_pages: 2 });
  assert.match(r.text, /^4 items from 2 page\(s\)/);
  assert.match(r.text, /Stopped after 2 pages \(max_pages\)/);
});

test("all_pages keeps earlier pages when a later page is not JSON", async () => {
  tokens();
  pages(3, { badPage: 1 });
  const r = await client.call(op("vsp360ListIdentityUsers"), { all_pages: true });
  assert.ok(r.ok);
  assert.match(r.text, /^2 items from 1 page\(s\)/);
  assert.match(r.text, /Stopped at page 2: the response was not a JSON array \(text\/html\)/);
});

test("all_pages with save_to writes every item to the file", async () => {
  tokens();
  pages(2);
  const r = await client.call(op("vsp360ListIdentityUsers"), { all_pages: true, save_to: "users.json" });
  assert.ok(r.ok, r.text);
  const file = join(dir, "downloads", "users.json");
  assert.match(r.text, /Saved \d+ bytes \(application\/json\)/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 4);
});

test("save_to is confined to the download folder and never overwrites", async () => {
  tokens();
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(200, "{}", json()).times(4);
  const outside = await client.call(op("vsp360GetAbout"), { save_to: join(dir, "elsewhere.json") });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /outside the download folder/);
  const escape = await client.call(op("vsp360GetAbout"), { save_to: "../escape.json" });
  assert.equal(escape.ok, false);
  const ok = await client.call(op("vsp360GetAbout"), { save_to: "sub/about.json" });
  assert.ok(ok.ok, ok.text);
  assert.ok(existsSync(join(dir, "downloads", "sub", "about.json")));
  const again = await client.call(op("vsp360GetAbout"), { save_to: "sub/about.json" });
  assert.equal(again.ok, false);
  assert.match(again.text, /already exists/);
});

test("VSP360_SAVE_ANYWHERE lifts the folder restriction", async () => {
  client = makeClient({ VSP360_SAVE_ANYWHERE: "true" });
  tokens();
  pool.intercept({ path: "/api/v1/vsp360/about", method: "GET" }).reply(200, "{}", json());
  const r = await client.call(op("vsp360GetAbout"), { save_to: join(dir, "elsewhere.json") });
  assert.ok(r.ok, r.text);
  assert.ok(existsSync(join(dir, "elsewhere.json")));
});

test("binary downloads are streamed to disk; a malformed file name falls back to a generated one", async () => {
  tokens();
  const body = Buffer.alloc(256 * 1024, 7);
  pool.intercept({ path: "/api/v1/vsp360/diagnostics/jobs/j1/download", method: "GET" }).reply(200, body, { headers: { "content-type": "application/gzip", "content-disposition": "attachment; filename*=UTF-8''bad%E0%A4%A.tar.gz" } });
  pool.intercept({ path: "/api/v1/vsp360/diagnostics/jobs/j2/download", method: "GET" }).reply(200, body, { headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="bundle.tar.gz"' } }).times(2);
  const bad = await client.call(op("vsp360GetDiagnosticsJobsByIdDownload"), { params: { id: "j1" } });
  assert.ok(bad.ok, bad.text);
  assert.match(bad.text, new RegExp(`Saved ${body.length} bytes`));
  assert.match(bad.text, /vsp360GetDiagnosticsJobsByIdDownload-.*\.tar\.gz/);
  const first = await client.call(op("vsp360GetDiagnosticsJobsByIdDownload"), { params: { id: "j2" } });
  const second = await client.call(op("vsp360GetDiagnosticsJobsByIdDownload"), { params: { id: "j2" } });
  assert.match(first.text, /bundle\.tar\.gz/);
  assert.match(second.text, /bundle-1\.tar\.gz/, "a second download with the same name gets a new name");
  assert.deepEqual(readdirSync(join(dir, "downloads")).length, 3);
});

test("uploads refuse hidden paths, and paths outside VSP360_UPLOAD_DIR when it is set", async () => {
  const hidden = join(dir, ".secret");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "devices.csv"), "a,b\n");
  const r = await client.call(op("vsp360PostDevicesEnrollmentTemplateValidate"), { params: { deviceType: "block" }, files: { file: join(hidden, "devices.csv") } });
  assert.equal(r.ok, false);
  assert.match(r.text, /hidden file or inside a hidden folder/);

  const uploads = join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(join(dir, "devices.csv"), "a,b\n");
  client = makeClient({ VSP360_UPLOAD_DIR: uploads });
  const outside = await client.call(op("vsp360PostDevicesEnrollmentTemplateValidate"), { params: { deviceType: "block" }, files: { file: join(dir, "devices.csv") } });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /outside VSP360_UPLOAD_DIR/);

  writeFileSync(join(uploads, "devices.csv"), "a,b\n");
  tokens();
  pool.intercept({ path: "/api/v1/vsp360/devices/enrollment-template/validate?deviceType=block", method: "POST" }).reply(200, '{"valid":true}', json());
  const inside = await client.call(op("vsp360PostDevicesEnrollmentTemplateValidate"), { params: { deviceType: "block" }, files: { file: join(uploads, "devices.csv") } });
  assert.ok(inside.ok, inside.text);
});
