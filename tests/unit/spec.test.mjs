// Unit tests for loading and indexing the OpenAPI spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spec, toolParamName } from "../../dist/spec.js";

const spec = new Spec(new URL("../../spec/Platform-vsp360-openapi.yaml", import.meta.url).pathname);

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
