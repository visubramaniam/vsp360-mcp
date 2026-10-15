# Changelog

## Unreleased

### Fixed

- **Docker builds no longer hang under emulation.** The image's build and dependency stages now run on the build machine's own platform and only the final stage is per platform, so multi-arch builds don't run `npm` under QEMU. In the 0.1.19 release, `npm ci` crashed there (SIGILL) and the build hung. The Release workflow's Docker job also stops after 30 minutes instead of hanging.
- **Docker actions on Node.js 24.** The Release workflow uses `docker/setup-qemu-action@v4`, `docker/setup-buildx-action@v4`, `docker/login-action@v4` and `docker/build-push-action@v7`, which run on Node.js 24, instead of the versions GitHub was forcing off its deprecated Node.js 20.

### Changed

- **Named as a community project.** The README, package description, Docker image labels and Claude Desktop extension now call vsp360-mcp a "Community MCP server for Hitachi VSP 360" and say it isn't an official Hitachi Vantara product. The extension shows as **Hitachi VSP 360 (Community)** in Claude Desktop's settings.

### Added

- **Claude plugin, `vsp360-community`** (`plugin/`). It runs the server with `npx vsp360-mcp@<version>`, asks for the VSP 360 settings (the client secret goes to the system's secure credential store), and adds two skills: capacity and performance reports via Analytics, and a platform health check. Install it in Claude Code with `/plugin install vsp360-community --marketplace visubramaniam/vsp360-mcp`; the repository's `.claude-plugin/marketplace.json` lists it. It's ready to submit to Anthropic's plugin directory. A unit test keeps its pinned version in step with `package.json`.

### Security

- **No real environment data in the repository (SECURITY.md S2).** Six report files with live VSP 360 data are no longer tracked, and `reports/` is ignored except `reports/decisions.jsonl`. Array names, serial numbers, and application and policy names in the test questions and an MQL example are replaced with placeholders. Earlier commits still contain the data.

## 0.1.19 — 2026-10-15

### Changed

- **Faster startup, less memory.** `npm run build` now writes a pre-parsed JSON copy of the bundled spec (`dist/openapi-cache.json`), and the server uses it instead of parsing the 2 MB YAML file at every start. On an Apple-silicon Mac, time to ready fell from about 540 ms to 270 ms, and peak memory from about 290 MB to 115 MB. The copy is keyed by the YAML file's SHA-256, so replacing the YAML file still takes effect at once. `VSP360_SPEC` also accepts a JSON file now.
- **Fewer turns for clear requests.** When a search has HIGH confidence, the top result's parameters are listed with the results (types, enum values, required body fields), so Claude can usually call it without a separate `vsp360_describe_operation`. It's skipped for operations blocked by the current settings and for `analyticsRunQuery`.
- **Compact JSON.** Responses and `describe` output are no longer indented; `describe` output for all 264 operations is 43% smaller. Files written with `save_to` stay indented.
- **Parallel pagination.** With `all_pages`, when the first page's `Link` header names both `next` and `last` and they differ only in `offset`, the remaining pages are fetched four at a time instead of one after another. Pages stay in order, `max_pages` still applies, and other APIs still follow `next` links in turn.

## 0.1.18 — 2026-10-14

### Added

- **GitHub Container Registry.** The Release workflow also pushes the Docker image to `ghcr.io/visubramaniam/vsp360-mcp`, using the workflow's own token. Docker Hub is still used when its secrets are set.
- **README badges** for the npm version and the Release workflow.

## 0.1.17 — 2026-10-14

### Security

- **Uploads in read-only mode need `VSP360_UPLOAD_DIR`.** Read-only mode allows one upload, the bulk-registration CSV check (`vsp360PostDevicesEnrollmentTemplateValidate`). Without an upload folder, a model steered by injected text could use it to send any local file that isn't hidden to VSP 360. In read-only mode, that operation is now refused, and has no direct tool, unless `VSP360_UPLOAD_DIR` is set. The Claude Desktop extension has a new **Upload folder** setting for this. (SECURITY.md S1)
- **Dependency updates.** `undici` is updated from 7.16.0 to 7.30.0, fixing 25 advisories, including unbounded decompression of responses. `yaml` is updated from 2.8.1 to 2.9.1, fixing a stack overflow on deeply nested YAML. (SECURITY.md D1, D2)

### Added

- **npm registry.** The package is published on npm as `vsp360-mcp`, so it installs with `npm install -g vsp360-mcp` or runs with `npx vsp360-mcp`. From the next release on, the Release workflow publishes it with npm trusted publishing, which needs no stored token and adds a provenance attestation. `package.json` now has repository, homepage, issue tracker, author and keyword fields, and `npm publish` runs the tests first.
- **INSTALL.md**, a guide to installing and deploying the server with each package: the Claude Desktop extension, standalone, npm, Docker and source. It also covers Claude Code and Claude Desktop setup, CI/CD pipelines, checksums, upgrading and uninstalling. It's included in the release packages.
- **SECURITY.md**, with how to report a vulnerability, the security model, and the results of a security review.

## 0.1.16 — 2026-10-14

### Added

- **Release packages.** Each GitHub release now has a Claude Desktop extension (`.mcpb`), standalone archives with Node.js 24 bundled in (macOS, Linux and Windows, x64 and arm64), an npm tarball for `npm install -g` and CI/CD, and a `SHA256SUMS` file. Build them locally with `npm run package`.
- **GitHub Actions.** The CI workflow runs the tests on Node.js 22 and 24 and checks that the packages build. The Release workflow runs on `v*` tags: it builds the packages, attaches them to the release, and pushes the multi-arch Docker image when Docker Hub secrets are set.

## 0.1.15 — 2026-10-14

The server now uses the Platform OpenAPI spec, `spec/Platform-vsp360-openapi.yaml`, which replaces `spec/vsp360-openapi.yaml`. It still covers 264 operations.

### Changed

- **Data Protection paths.** The 25 Data Protection operations now use `/dataprotection/api/v1/protection` in the spec itself. The default `VSP360_PATH_REWRITES` rule stays, because the service's pagination (`next`) links still leave out the `/dataprotection` prefix.
- **Orchestration paths.** The 11 Orchestration operations moved to `/orchestration/api/v1/execute`. On the lab, the old paths returned the web UI instead of the API, so these workflow calls now work.
- **Search ranking.** The decision model was retrained on the new spec. On the user test set, 30 of 77 questions now meet the confidence thresholds (up from 23). On the held-out batch, 25 of 45 do (up from 17).

### Added

- `vsp360GetAuthenticationSettingsPasswordPolicy` reads the password policy, with example questions for search. On the lab's current build it returns 404.

### Removed

- `orchestrationExecuteNdm` (nondisruptive migration) is no longer in the API, so the server no longer offers it. As a result, the number of write operations drops from 125 to 124.
- The old `spec/vsp360-openapi.yaml` file.

### Upgrading

- If `VSP360_SPEC` points at the old bundled `spec/vsp360-openapi.yaml`, remove the setting or point it at `spec/Platform-vsp360-openapi.yaml`.
- Any prompts or automation that call `orchestrationExecuteNdm` need to change, because that operation no longer exists.
