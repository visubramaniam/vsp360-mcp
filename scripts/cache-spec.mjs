#!/usr/bin/env node
// Writes dist/openapi-cache.json, a pre-parsed copy of the bundled YAML spec, so the server starts without
// parsing YAML. Run by `npm run build` after tsc. The server uses the copy only while the YAML is unchanged.
import { readFileSync, writeFileSync } from "node:fs";
import { SPEC_CACHE, specCache } from "../dist/spec.js";
import { bundled } from "../dist/config.js";

writeFileSync(SPEC_CACHE, specCache(readFileSync(bundled("spec", "Platform-vsp360-openapi.yaml"), "utf8")));
