# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability**. Don't open a public issue for a security problem.

Include the version, your configuration (with secrets removed) and steps to reproduce. Fixes are released for the latest version only.

## Security model

vsp360-mcp runs locally and talks MCP over standard input and output. It holds a VSP 360 service account's client ID and secret and makes HTTPS requests to one VSP 360 on behalf of an MCP client, usually an AI model.

The design assumes:

- **The local user or operator is trusted.** They set the environment variables and choose what the server may do.
- **The model is semi-trusted.** It can be steered by prompt injection, for example by text in VSP 360 data it reads, so the server limits what the model can do on its own.
- **VSP 360 responses are untrusted input.**

The controls that follow from this:

| Control | Default | Setting |
|---|---|---|
| Only reads are allowed; `POST`, `PUT`, `PATCH` and `DELETE` operations are refused, except a short list of `POST`s that only read or validate | on | `VSP360_ALLOW_WRITES=true` turns it off |
| The read that returns a live client secret (`vsp360GetServiceAccountSecret`) is refused, even when writes are allowed | on | `VSP360_ALLOW_SECRET_READS=true` |
| Downloads and `save_to` files are written only inside one folder and never overwrite an existing file | `~/Downloads/vsp360-mcp` | `VSP360_DOWNLOAD_DIR`, `VSP360_SAVE_ANYWHERE` |
| Uploads refuse hidden files and folders (`~/.ssh`, `.env`, ...), or anything outside one folder if it's set. In read-only mode, uploads are refused unless that folder is set. | hidden paths refused; read-only mode refuses uploads | `VSP360_UPLOAD_DIR` |
| TLS certificates are verified | on | `VSP360_CA_CERT`, `VSP360_INSECURE_TLS` |
| Pagination `next` links are re-homed to `VSP360_URL`, so the token is never sent to another host | always | |
| Credentials are never written to logs, tool output or the decision log | always | |

The safest configuration for unattended or shared use is read-only, with `VSP360_UPLOAD_DIR` set to a dedicated folder, TLS verification on, and a service account that has only the VSP 360 access the job needs.

## Security review — 2026-10-14

| | |
|---|---|
| **Version reviewed** | 0.1.16 (commit `18085ac`) |
| **Reviewer** | Automated review by Claude (Fable 5.1), with the main findings checked against the code by Claude (Opus 5.5) |
| **Method** | Static review of `src/`, the packaging script, the `.mcpb` manifest, the Dockerfile and the GitHub workflows. Findings were tested by running the compiled server's functions locally against a mock HTTP server, plus `npm audit` for dependencies. |
| **Not covered** | Behaviour of a live VSP 360, Windows path handling, and Linux-only paths (reasoned about, not run) |

No critical or high-severity issues were found in the server's own code. The most important problems were an upload path that read-only mode didn't fully close (S1), environment data in the public repository (S2), and a vulnerable `undici` version (D1). S1, D1 and D2 are fixed in 0.1.17; the rest are open.

### Findings in the code

| ID | Severity | Finding | Status |
|---|---|---|---|
| S1 | Medium | Read-only mode allows a file upload | Fixed in 0.1.17 |
| S2 | Medium | The public repository contains data from a real environment | Open |
| S3 | Low | Redirects are followed, including for the token request | Open |
| S4 | Low | `vsp360VerifyDirectory` is treated as read-only but can make VSP 360 connect to any LDAP host | Open |
| S5 | Low | `analyticsRunQuery` is treated as read-only whatever its `action` is | Open |
| S6 | Low | Two write operations return a live client secret without `VSP360_ALLOW_SECRET_READS` | Open |
| S7 | Low | `save_to` can be redirected by a symlink inside the download folder | Open |
| S8 | Low | `.` and `..` path parameters remove URL segments | Open |
| S9 | Low | Responses and pagination are not size-limited before buffering | Open |
| S10 | Low | An `http://` VSP 360 URL is accepted without a warning | Open |
| S11 | Low | CI actions and base images are pinned by tag, not by digest | Open |

**S1 — Read-only mode allows a file upload (Medium).** `vsp360PostDevicesEnrollmentTemplateValidate` (`src/spec.ts`, `READ_ONLY_POSTS`) checks a bulk-registration CSV and changes nothing, so it's allowed in read-only mode. But it takes a file upload, and without `VSP360_UPLOAD_DIR` any readable file that isn't hidden can be sent (`uploadPath` in `src/client.ts`). A model steered by injected text could upload a local file to VSP 360, such as an MCP client config file that holds credentials. VSP 360 echoes rows from the file in its validation errors, so the content can also end up in the conversation. The same applies on Linux to `/proc/self/environ`, which holds the server's own environment.
*Fixed:* in read-only mode, any operation that uploads a file is now refused, and gets no direct tool, unless `VSP360_UPLOAD_DIR` is set; the file must then be inside that folder (`blockedReason` in `src/index.ts`). With writes allowed, uploads keep the hidden-path rule, so setting `VSP360_UPLOAD_DIR` is still recommended. The Claude Desktop extension has an **Upload folder** setting. Test: `read-only mode refuses uploads unless VSP360_UPLOAD_DIR is set` in `tests/unit/server.test.mjs`.
*For 0.1.16 and earlier:* set `VSP360_UPLOAD_DIR` to an empty, dedicated folder.

**S2 — Environment data in the public repository (Medium).** Files under `reports/`, and some examples in `tests/` and `src/analyticsfields.ts`, contain names, serial numbers, WWNs, host names and private IP addresses from a real storage environment. `reports/` is not in `.gitignore`, so new reports with live data are easy to commit by mistake.
*Fix:* remove those files and identifiers, and rewrite history if the data mustn't stay public. Add `reports/` to `.gitignore`, and replace real identifiers in examples with placeholders.

**S3 — Redirects are followed (Low).** No request sets a redirect policy (`src/client.ts`). If the token endpoint returns a 307 or 308 redirect to another host, the token request body, which contains the client secret, is sent to that host. The `Authorization` header on API requests is dropped on cross-origin redirects, so API calls are not affected. This needs a misbehaving gateway, or a man-in-the-middle when `VSP360_INSECURE_TLS=true`.
*Fix:* `redirect: "error"` on the token request, and refuse cross-origin redirects on API requests.

**S4 — `vsp360VerifyDirectory` (Low).** This operation tests an LDAP connection with a caller-supplied URL and bind credentials, and is allowed in read-only mode. A steered model could make VSP 360 probe internal hosts, or send a bind password from the conversation to a host the attacker chose. It needs the `directories:manage` permission.
*Fix:* remove it from `READ_ONLY_POSTS`, or document the risk.

**S5 — `analyticsRunQuery` actions (Low).** The `action` parameter isn't restricted, so non-query actions such as aborting other users' queries are allowed as "reads".
*Fix:* allow only `action=query`.

**S6 — Incomplete secret gate (Low).** `vsp360RevealBlockSSOSetup` and `vsp360RotateBlockSSOSecret` return a live OIDC `clientSecret`. They need `VSP360_ALLOW_WRITES`, but not `VSP360_ALLOW_SECRET_READS`, which the README says covers secrets.
*Fix:* gate both on `VSP360_ALLOW_SECRET_READS` as well, or mask `clientSecret` in output.

**S7 — `save_to` and symlinks (Low).** The download-folder check compares paths as text, without resolving symlinks. An existing symlink inside the folder therefore lets a write land outside it. With `VSP360_SAVE_ANYWHERE=true`, new files can also be created in hidden folders such as `~/.ssh` or `~/.config`, although existing files are never overwritten.
*Fix:* resolve the parent folder's real path before the check, and refuse hidden paths for `save_to` as well.

**S8 — `.` and `..` path parameters (Low).** `encodeURIComponent` leaves `.` unchanged, and URL normalisation then removes `.` and `..` segments. A check of every allowed operation against every blocked one in the bundled spec found no way to reach a blocked operation, but undocumented endpoints could be reached.
*Fix:* reject path parameter values that are `.` or `..`, or that contain `/` or `\`.

**S9 — Unbounded responses (Low).** Response bodies are read in full before `VSP360_MAX_RESPONSE_CHARS` truncates them, and `max_pages` isn't clamped to its documented maximum of 200. A very large or endlessly paginated response could exhaust the server's memory.
*Fix:* clamp `max_pages`, and stop reading a response once a byte limit is reached.

**S10 — Plain-HTTP URL (Low).** With an `http://` `VSP360_URL`, the client secret and tokens are sent unencrypted.
*Fix:* refuse `http://`, or require an explicit opt-in.

**S11 — Supply chain (Low).** GitHub Actions and the `node:22-alpine` base image are pinned by tag rather than by commit SHA or digest. The packaging script checks the Node.js runtimes against nodejs.org's `SHASUMS256.txt` but doesn't verify its signature, and dependency updates aren't automated.
*Fix:* pin actions by SHA, pin the base image by digest, verify the signed `SHASUMS256.txt`, and enable Dependabot.

### Dependencies (`npm audit`)

After the upgrades, `npm audit --omit=dev` reports no vulnerabilities in the runtime dependencies.

| ID | Package | Used | Severity | Exposure | Fix |
|---|---|---|---|---|---|
| D1 | `undici` 7.16.0 | At runtime, for every VSP 360 request | High (25 advisories), **fixed in 0.1.17** | Mostly in features the server doesn't use (WebSockets, caching, cookies, retry interceptors). The ones that apply are unbounded decompression of responses (GHSA-g9mf-h72j-4rw9, GHSA-3xpg-4rpp-hhhm), which lets VSP 360, or anything that can tamper with its responses, exhaust memory. | Upgraded to 7.30.0 |
| D2 | `yaml` 2.8.1 | At runtime, to parse the spec | Moderate (GHSA-48c2-rrv3-qjmp), **fixed in 0.1.17** | Only matters if `VSP360_SPEC` points at an untrusted file | Upgraded to 2.9.1 |
| D3 | `node-forge`, `tmp` (via `@anthropic-ai/mcpb`) | At build time only | High | Not shipped in any package; used only when packing the `.mcpb` | Track upstream; no fix published for `node-forge` yet |

### Controls verified as working

- Blocked operations are refused before any request is sent, and no direct tool is created for them. Operation names are matched exactly, and `PUT`, `PATCH` and `DELETE` are never treated as reads.
- The token endpoint is never exposed as a tool.
- Unknown parameters are rejected. Path parameters are URL-encoded, query strings are built safely, and line breaks in header values are rejected.
- Pagination links pointing to other hosts are re-homed to `VSP360_URL`, so the token isn't sent elsewhere or over plain HTTP.
- Server-supplied download filenames are reduced to a bare file name, which prevents `../` traversal. `save_to` refuses `..`, absolute and `~` paths, and never overwrites an existing file.
- Upload paths are resolved through symlinks before they're checked. Uploads can't escape `VSP360_UPLOAD_DIR` through a symlink.
- TLS verification is on by default.
- No credentials appear in logs, tool output, the decision log or startup messages.
- The `.mcpb` manifest marks the client secret as sensitive and defaults to read-only with TLS verification on.
- The GitHub workflows have read-only permissions by default, give write access only to the release job, pass tag names through environment variables rather than inline expressions, and don't use `pull_request_target`. The Docker image runs as a non-root user.
