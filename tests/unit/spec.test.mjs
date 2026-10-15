// Unit tests for loading and indexing the OpenAPI spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spec, SPEC_CACHE, parseYaml, toolParamName } from "../../dist/spec.js";

const SPEC_FILE = new URL("../../spec/Platform-vsp360-openapi.yaml", import.meta.url).pathname;
const spec = new Spec(SPEC_FILE);

test("indexes 264 operations, hides the token endpoint, and flags exactly one secret read", () => {
  assert.equal(spec.operations.size, 264);
  assert.ok(!spec.operations.has("vsp360PostAuthToken"));
  assert.deepEqual([...spec.operations.values()].filter((o) => o.secret).map((o) => o.operationId), ["vsp360GetServiceAccountSecret"]);
});

test("read-only operations are GETs plus the listed query/validate POSTs", () => {
  for (const op of spec.operations.values()) {
    if (op.method === "GET") assert.ok(op.readOnly, op.operationId);
    if (["PUT", "PATCH", "DELETE"].includes(op.method)) assert.ok(!op.readOnly, op.operationId);
  }
  const readOnlyPosts = [...spec.operations.values()].filter((o) => o.method === "POST" && o.readOnly).map((o) => o.operationId).sort();
  assert.equal(readOnlyPosts.length, 7);
  assert.ok(readOnlyPosts.includes("analyticsRunQuery"));
});

test("every operation has a response schema available after the document is released", () => {
  for (const op of spec.operations.values()) assert.notEqual(spec.responseSchema(op), undefined, op.operationId);
});

test("tool-safe parameter names are valid and do not collide", () => {
  const reserved = new Set(["body", "files", "all_pages", "max_pages", "save_to"]);
  for (const op of spec.operations.values()) {
    const names = op.params.map((p) => toolParamName(p.name));
    for (const n of names) {
      assert.match(n, /^[A-Za-z0-9_.-]{1,64}$/, `${op.operationId}: ${n}`);
      assert.ok(!reserved.has(n), `${op.operationId}: ${n} collides with a call argument`);
    }
    assert.equal(new Set(names).size, names.length, `${op.operationId}: duplicate parameter names`);
  }
  assert.equal(toolParamName("match[]"), "match");
});

test("$ref resolution cuts off recursion and turns nullable into a type union", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp360-spec-"));
  const file = join(dir, "mini.yaml");
  writeFileSync(file, `
openapi: 3.0.3
info: { title: t, version: "1" }
tags: [{ name: Things, description: "Things that you can list here. More text." }]
paths:
  /things:
    get:
      operationId: listThings
      tags: [Things]
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Node" }
components:
  schemas:
    Node:
      type: object
      properties:
        name: { type: string, nullable: true, example: x }
        child: { $ref: "#/components/schemas/Node" }
`);
  try {
    const s = new Spec(file);
    const schema = s.responseSchema(s.operations.get("listThings")).schema;
    assert.deepEqual(schema.properties.name.type, ["string", "null"]);
    assert.equal(schema.properties.name.example, undefined, "examples are dropped");
    assert.match(schema.properties.child.description, /Node \(nested; see describe_operation\)/);
    assert.equal(s.tags[0].description, "Things that you can list here.", "tag descriptions keep their first sentence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build-time cache is the bundled YAML, parsed", () => {
  const cache = JSON.parse(readFileSync(SPEC_CACHE, "utf8"));
  assert.deepEqual(cache.doc, parseYaml(readFileSync(SPEC_FILE, "utf8")));
});

test("a changed YAML spec is parsed afresh rather than taken from the cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp360-spec-"));
  const file = join(dir, "changed.yaml");
  const yaml = readFileSync(SPEC_FILE, "utf8");
  const summary = spec.operations.get("vsp360GetAlerts").summary;
  writeFileSync(file, yaml.replace(`summary: ${summary}`, "summary: Changed summary"));
  try {
    assert.equal(new Spec(file).operations.get("vsp360GetAlerts").summary, "Changed summary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a JSON spec loads like the YAML one", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsp360-spec-"));
  const file = join(dir, "spec.json");
  writeFileSync(file, JSON.stringify(parseYaml(readFileSync(SPEC_FILE, "utf8"))));
  try {
    const s = new Spec(file);
    assert.deepEqual([...s.operations.keys()], [...spec.operations.keys()]);
    assert.deepEqual(s.responseSchema(s.operations.get("vsp360GetAlerts")), spec.responseSchema(spec.operations.get("vsp360GetAlerts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
