# vsp360-mcp: Community MCP server for Hitachi VSP 360

[![npm](https://img.shields.io/npm/v/vsp360-mcp)](https://www.npmjs.com/package/vsp360-mcp) [![Release](https://github.com/visubramaniam/vsp360-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/visubramaniam/vsp360-mcp/actions/workflows/release.yml)

An MCP server for the **Hitachi VSP 360 1.4 REST API**, built from the Platform OpenAPI spec `spec/Platform-vsp360-openapi.yaml`. It gives Claude (or any other MCP client) access to all 264 API operations. The token endpoint is excluded because the server handles authentication itself.

> Not an official Hitachi Vantara product: vsp360-mcp is an independent, community project, and isn't supported by or affiliated with Hitachi Vantara. Hitachi and VSP 360 are trademarks of their owners.

## How it exposes the API

The spec is too large to load as 264 separate tools: their schemas alone come to about 400 KB. The server therefore always provides three discovery tools:

| Tool | Purpose |
|---|---|
| `vsp360_list_operations` | Lists the 35 API areas. With `tag` or `query`, lists the matching operations. |
| `vsp360_describe_operation` | Shows the parameters, request body, response schema, required permissions and prerequisites for one operation. |
| `vsp360_call_operation` | Calls any operation by `operationId`. |

For the areas you use most, set `VSP360_TOOLSETS` to add **direct tools**: one tool per operation, each with a full input schema. For example:

```
VSP360_TOOLSETS="Device Registry,Platform Alerts,VSP 360 Cluster Health"
```

### How `vsp360_list_operations` finds operations

A search goes through three steps. Only the first one ranks; the other two add advice to the ranked list.

1. **BM25 ranking** picks and orders the operations.
2. **A confidence rating** (HIGH, MEDIUM or LOW) says how far to trust the top result.
3. **An optional learned hint** suggests what to do next. It is off unless `VSP360_DECISION_HINT` is set.

#### 1. BM25 ranking

A `query` is ranked with **BM25** over each operation's ID, summary, tag, path, description and a set of **example questions** (`spec/examples.json`), so plain-language requests work ("volumes with no host path", "silence alerts"). The ranking has six refinements:

- **Fields are weighted:** words in the summary and ID count more than words in the description.
- **camelCase is split and light stemming is applied.**
- **Storage vocabulary is mapped to API terms,** for example volume → ldev, LDAP → directories, ESXi → hypervisor.
- **Verbs decide intent:** "list" and "show" favour read operations, while "delete", "start" and "register" favour write operations.
- **List-style requests prefer collection endpoints** over `{id}` endpoints.
- **Example questions bridge operator wording and API wording:** each operation has a few questions an operator might ask, such as "take a snapshot now outside the schedule" for `protectionTriggerPolicy`. Set `VSP360_EXAMPLES` to another file to use your own, or to an empty string to turn them off.

#### 2. Confidence rating

Each result set carries a **confidence** of HIGH, MEDIUM or LOW, based on how far the top hit leads the next and how much of the request's own wording it matches. The rating comes with advice: call the top result, check its description, or describe the top two or three. With HIGH confidence, the top result's parameters are listed too (types, enum values, required body fields), so Claude can usually call it without spending a turn on `vsp360_describe_operation`. This is skipped when the top result is blocked by the current settings, and for `analyticsRunQuery`, which needs describe's MQL reference. When a LOW or MEDIUM result looks like a performance or topology question, the response points to `analyticsRunQuery`.

#### 3. Learned hint (optional)

With `VSP360_DECISION_HINT=true`, a line under the results suggests what to do with them: call the top operation, compare the top few, answer with Analytics, or search again. It comes from a small model in `spec/decision-model.json`, trained on logged searches (see [Improving search](#improving-search-logging-and-the-learned-hint)). It never changes the ranking. With `ab`, it is shown in a random half of server sessions so the two can be compared.

#### Analytics (MQL) field reference

The spec documents the Analytics query endpoint but not what it can query. Describing `analyticsRunQuery` therefore adds an `mqlReference`: MQL usage notes, the attributes and relations of the most-used resource types (`raidStorage`, `raidPool`, `raidLdev`, `raidPort`, `raidHG`, `raidLU`, `raidPortWWN`, `raidPair`, the host, fabric and VMware types), and the names of the other 38 types. Describing it with `resourceType` (for example `raidPool`) returns one type's full attribute list. The block, file and object types come from the *VSP 360 Metrics Reference Guide*; the host, fabric and VMware types were found on a live system and may be incomplete. The reference lives in `spec/analytics-fields.json` (`VSP360_ANALYTICS_FIELDS` points to another file).

#### Measuring search

All user questions live in [`tests/user-queries.md`](tests/user-queries.md): regression prompts, labelled questions for evaluation and training, and batch questions for data collection.


`npm test` builds the server, runs the unit tests in `tests/unit/` (the HTTP client against a mock server, the spec loader, and the MCP server end to end, including the read-only block) and then the search evaluation, which fails if any score drops below its threshold. `npm run eval` scores the search against 83 labelled development requests (45 held out from tuning) and the 119 labelled user questions in `tests/user-queries.md` (79 held out); `EXAMPLES=0 npm run eval` measures it without the example questions.

## Safety: read-only by default

By default only `GET` operations are allowed, plus a few `POST` operations that only query or validate:
- analytics query
- inventory filter query
- authorization check
- user capabilities
- CSV validation
- upgrade version validation
- directory connection test

All other operations are refused, and direct tools are not created for them. These include device registration and deletion, orchestration workflows (volume allocation, expansion, GAD), user and group changes, certificates, upgrades and notifications. To allow them, set `VSP360_ALLOW_WRITES=true`. `DELETE` tools are marked `destructiveHint`, so Claude asks for confirmation before running them.

**Reads that return secrets.** One read, `vsp360GetServiceAccountSecret`, returns a service account's live client secret, which would then become part of the conversation. Every other read masks secrets. That read is refused, whether or not writes are allowed, unless `VSP360_ALLOW_SECRET_READS=true`.

**Local files.** Claude chooses `save_to` and upload paths, so text it reads from the API could try to steer them. `save_to` therefore only writes inside `VSP360_DOWNLOAD_DIR` and never overwrites a file (set `VSP360_SAVE_ANYWHERE=true` to lift the folder rule). Uploads refuse hidden files and folders such as `~/.ssh` or `.env`; set `VSP360_UPLOAD_DIR` to allow uploads only from one folder. In read-only mode, the one upload allowed (CSV validation) is refused unless `VSP360_UPLOAD_DIR` is set, because it would otherwise let a steered model send any local file to VSP 360.

## Features

- **Auth:** Gets an OAuth2 `client_credentials` token from `POST /api/v1/vsp360/auth/token`. It reuses the token until shortly before it expires and fetches a new one automatically after a 401.
- **Pagination:** Use `limit` and `offset` (at most 100 per page), or set `all_pages: true` to fetch every page. When the first page's `Link` header gives both `next` and `last`, the remaining pages are fetched four at a time; otherwise the `next` links are followed one by one. `max_pages` caps the number of pages and defaults to 20. The `Content-Range` and `Link` headers are included in each result. If a later page is not JSON (for example a gateway error page), the pages before it are kept and a note says where it stopped.
- **Downloads:** Binary responses are streamed to `VSP360_DOWNLOAD_DIR`, so large bundles never sit in memory, and the file path is returned. These include diagnostic bundles (`.tar.gz`), CSR ZIPs and billing reports. A name the server already used gets a numbered suffix. Any call can also pass `save_to: "report.json"` (a file name or a path inside the download folder); with `all_pages`, every page is saved.
- **Uploads:** Multipart operations take local file paths, for example `files: {"file": "~/devices.csv"}`. This applies to installing a TLS certificate, validating a bulk-registration CSV, and uploading an upgrade package. Files are streamed from disk, so 20 GB `.zst` upgrade packages don't need to fit in memory. Hidden files are refused (see [Safety](#safety-read-only-by-default)).
- **TLS:** Use `VSP360_CA_CERT` for a private CA. Use `VSP360_INSECURE_TLS=true` only for lab systems with self-signed certificates.
- **Compact responses:** JSON responses and `vsp360_describe_operation` output are returned without indentation, which is about 40% fewer characters for the model to read. Files written with `save_to` stay indented.
- **Large responses:** Responses longer than `VSP360_MAX_RESPONSE_CHARS` are truncated, with a note telling Claude how to narrow the request.

## Improving search: logging and the learned hint

These tools collect data on how Claude uses search results and train the learned hint from it. None of them is needed to use the server.

### Decision log

Set `VSP360_DECISION_LOG` to a file path to record, locally, how search results are used:

- **For each search:** the query and, if Claude passes it, the user's own request that led to the search (the `request` argument, offered only while the log is on and never used for ranking); the confidence rating and the signals behind it (lead, coverage, intent, the analytics hint), and the ranked operationIds.
- **For each describe or call:** the operationId, its rank in the most recent search if it started within `VSP360_DECISION_LINK_SECONDS` of it (otherwise it is logged as unlinked), the seconds since that search, the HTTP status and the duration. Calls also record the *names* of the arguments used.

Argument values, request and response bodies, headers and credentials are never logged. The query text is logged as typed, so treat the file as you would chat history.

### Collection mode

With `VSP360_DECISION_COLLECT=true` (and the log on), the server makes every question produce a labelled search: a search with `query` must also carry `request`, and `vsp360_call_operation` (or a direct tool) is refused unless the operation appeared in a search result within the last `VSP360_DECISION_COLLECT_SECONDS` (default 600). Refusals are logged. Claude is slower in this mode, so turn it on for a data-collection period and off afterwards; turning writes off (`VSP360_ALLOW_WRITES` unset) for the period is also a good idea.

### Batch collection

`npm run collect-batch -- --part N` sends the questions in one part of `tests/user-queries.md` to Claude through the API, one fresh conversation per question, with its own vsp360 server running read-only in collection mode. It needs an Anthropic API key (`ANTHROPIC_API_KEY`; usage is billed), skips the held-out test questions, resumes where it stopped, and writes to `reports/decisions-batch.jsonl` (decisions) and `reports/batch-answers.jsonl` (answers, which contain live VSP 360 data). `--dry-run` lists what would run; `--limit N`, `--only 1,2`, `--model` and `--effort` adjust a run.

### Training the learned hint

`spec/decision-model.json` is a small learned model (`npm run train-decision -- --write` rebuilds it) that suggests what to do with a search result: call the top operation, compare the top few, use Analytics, or search again. With `VSP360_DECISION_HINT=true` the suggestion is added under the search results; with `ab` it is shown in a random half of server sessions, so the decision log can compare sessions with and without it. While the log is on, the prediction is recorded either way. `collect-batch` takes `--hint off|on|ab`.

### Reports

`npm run decision-report -- <log.jsonl> [--csv out.csv]` turns the log into one row per search, labelled with what happened next (top result called, another result called, an operation not in the results called, or nothing called). Searches whose `request` matches a held-out test question in `tests/user-queries.md` are flagged so they can be kept out of training. When the hint runs in `ab` mode, the report also compares sessions that saw it with sessions that did not. `npm run train-decision` trains the model on these rows and compares it with the confidence thresholds on held-out questions.

## Setup

[INSTALL.md](INSTALL.md) has the full installation and deployment guide, including Windows, CI/CD pipelines, checksums, upgrading and troubleshooting. In short:

First, create a service account in VSP 360 and note its client ID and secret. Give it the access your use case needs: `admin` covers alerts, logs and system operations; for devices, use a group whose access policy covers the device types.

Then install the server in one of these ways. Each [GitHub release](https://github.com/visubramaniam/vsp360-mcp/releases) has the packages and a `SHA256SUMS` file.

| Package | Needs | Use it for |
|---|---|---|
| `vsp360-mcp-<version>.mcpb` | Claude Desktop | One-click install: open the file and Claude Desktop asks for the URL, client ID and secret. |
| `vsp360-mcp-<version>-<platform>.tar.gz` / `.zip` | nothing | Standalone install on macOS, Linux or Windows (x64 and arm64), with Node.js bundled in. |
| npm package (`vsp360-mcp` on the npm registry) | Node.js 20+ | `npm install -g vsp360-mcp`, CI/CD pipelines. |
| Docker image | Docker | See [README.docker.md](README.docker.md). |
| Source | Node.js 22+ | Development: `npm install && npm run build`, then use `node /ABSOLUTE/PATH/TO/vsp360-mcp/dist/index.js` as the command. |

**Standalone.** Unpack the archive anywhere and use `bin/vsp360-mcp` (`bin\vsp360-mcp.cmd` on Windows) as the server command. You can symlink it onto your `PATH`:

```bash
tar -xzf vsp360-mcp-0.1.19-linux-x64.tar.gz -C /opt && ln -s /opt/vsp360-mcp-0.1.19-linux-x64/bin/vsp360-mcp /usr/local/bin/vsp360-mcp
```

**npm or CI/CD.** Install from the npm registry (version 0.1.17 and later). The `vsp360-mcp` command then starts the server:

```bash
npm install -g vsp360-mcp
```

Each GitHub release also has the same package as `vsp360-mcp-<version>.tgz`, for machines that can't reach the registry.

The examples below use `vsp360-mcp` as the command; substitute the path from whichever install you chose.

### Claude Code

```bash
claude mcp add vsp360 -e VSP360_URL=https://vsp360.example.com -e VSP360_CLIENT_ID=my-service-account -e VSP360_CLIENT_SECRET=REPLACE_ME -e "VSP360_TOOLSETS=Device Registry,Platform Alerts" -- vsp360-mcp
```

### Claude Desktop

The `.mcpb` package is the easiest way. To configure it by hand instead, add this to `~/Library/Application Support/Claude/claude_desktop_config.json`. Claude Desktop does not read your shell's `PATH`, so give the command's full path, e.g. `/usr/local/bin/vsp360-mcp`:

```json
{
  "mcpServers": {
    "vsp360": {
      "command": "/usr/local/bin/vsp360-mcp",
      "env": {
        "VSP360_URL": "https://vsp360.example.com",
        "VSP360_CLIENT_ID": "my-service-account",
        "VSP360_CLIENT_SECRET": "REPLACE_ME",
        "VSP360_TOOLSETS": "Device Registry,Platform Alerts"
      }
    }
  }
}
```

To try the tools interactively, run `npm run inspect`. It opens the MCP Inspector and needs the environment variables set in your shell.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VSP360_URL` | *(required)* | Base URL, e.g. `https://vsp360.example.com` |
| `VSP360_CLIENT_ID` | *(required)* | Service account client ID |
| `VSP360_CLIENT_SECRET` | *(required)* | Service account client secret |
| `VSP360_SCOPE` | | Optional OAuth scope |
| `VSP360_ALLOW_WRITES` | `false` | Allow operations that change state |
| `VSP360_ALLOW_SECRET_READS` | `false` | Allow `vsp360GetServiceAccountSecret`, which returns a live client secret |
| `VSP360_TOOLSETS` | *(none)* | Comma-separated API areas (tags) to expose as direct tools. `all` exposes all 264, which is not recommended. |
| `VSP360_CA_CERT` | | PEM file of the CA that signed the VSP 360 certificate |
| `VSP360_INSECURE_TLS` | `false` | Skip TLS verification (lab use only) |
| `VSP360_TIMEOUT_MS` | `120000` | Request timeout; uploads are exempt |
| `VSP360_MAX_RESPONSE_CHARS` | `60000` | Truncation limit for text responses |
| `VSP360_DOWNLOAD_DIR` | `~/Downloads/vsp360-mcp` | Where binary downloads and `save_to` files are written |
| `VSP360_SAVE_ANYWHERE` | `false` | Let `save_to` write outside `VSP360_DOWNLOAD_DIR` |
| `VSP360_UPLOAD_DIR` | *(any non-hidden path)* | Only allow uploads from inside this folder. In read-only mode, uploads are refused unless it's set. |
| `VSP360_PATH_REWRITES` | `/api/v1/protection=/dataprotection/api/v1/protection` | Path prefixes to rewrite, as comma-separated `/from=/to` pairs. The Data Protection service's pagination (`next`) links leave out its `/dataprotection` gateway prefix; the default puts it back. It also lets older specs without the prefix work. |
| `VSP360_ANALYTICS_FIELDS` | bundled `spec/analytics-fields.json` | MQL resource types and attributes added to `analyticsRunQuery`'s description. |
| `VSP360_EXAMPLES` | bundled `spec/examples.json` | Example user questions per operation, used to rank search results. Set to an empty string to turn them off. |
| `VSP360_SPEC` | bundled spec | Path to a different OpenAPI file, YAML or JSON, e.g. a newer VSP 360 release. JSON loads faster. |

These settings belong to the optional search-improvement tools ([Improving search](#improving-search-logging-and-the-learned-hint)); none is needed to use the server:

| Variable | Default | Description |
|---|---|---|
| `VSP360_DECISION_LOG` | *(off)* | Path to a JSON Lines file. When set, each search, describe and call is logged locally (see [Decision log](#decision-log)). |
| `VSP360_DECISION_LINK_SECONDS` | `120` | A describe or call is tied to the latest search only if it starts within this many seconds of it. |
| `VSP360_DECISION_COLLECT` | `false` | `true` turns on collection mode (needs `VSP360_DECISION_LOG`). |
| `VSP360_DECISION_COLLECT_SECONDS` | `600` | In collection mode, how long a search result keeps its operations callable. |
| `VSP360_DECISION_HINT` | `false` | `true` adds the learned model's suggested next step to search results; `ab` does so in a random half of sessions. |
| `VSP360_DECISION_MODEL` | bundled `spec/decision-model.json` | The learned model used by the hint. |

## Tag names for `VSP360_TOOLSETS`

Users · Groups · Group Access · Service Accounts · Roles · Identity Providers · Active Directory · Authentication Settings · Authorization · Access Catalog · Access Policies · Privileged Access Management · Block Single Sign-On · Device Registration · Device Registry · Device Operation Jobs · File and Object Device Registration · Host and Hypervisor Discovery · Platform Alerts · VSP 360 Cluster Health · Logs · Diagnostics · Platform Profiles · Resource Management · Platform Upgrade · Application Lifecycle · TLS Certificates · Trusted CA Certificates · Notifications · Usage and Billing Reports · Product Information · Data Protection / Copies · Data Protection / Policies · Orchestration / Execute Workflows · Analytics / Query API

## Building the packages

`npm run package` builds every release package into `release/`. Use `--only npm,mcpb,standalone` and `--targets linux-x64,...` to build fewer, e.g. `npm run package -- --only standalone --targets darwin-arm64`. The standalone packages bundle Node.js 24, downloaded from nodejs.org and checked against its published SHA-256 sums.

The [Release workflow](.github/workflows/release.yml) runs when a `v*` tag is pushed. It runs the tests, builds the packages and attaches them to the tag's GitHub release; if that release doesn't exist yet, it's created from the version's `CHANGELOG.md` section. It then publishes the same `.tgz` to the npm registry with [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored and each version gets a provenance attestation; this is skipped if that version is already on npm. The trusted publisher is set up on npmjs.com under the package's **Settings → Trusted Publisher** (repository `visubramaniam/vsp360-mcp`, workflow `release.yml`). It pushes the `linux/amd64` and `linux/arm64` Docker image to `ghcr.io/visubramaniam/vsp360-mcp` using the workflow's own token, and also to Docker Hub if the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets are set. To rebuild an existing tag's packages, run the workflow by hand with that tag.

## Updating for a new VSP 360 release

Replace `spec/Platform-vsp360-openapi.yaml` (or point `VSP360_SPEC` at the new file) and restart the server. No code is generated from the spec, so nothing needs rebuilding. `npm run build` keeps a pre-parsed copy of the bundled spec in `dist/openapi-cache.json`, so the server starts without parsing YAML. The copy is only used while the YAML file is unchanged, so a replaced file is parsed afresh, which adds about a quarter of a second to startup. Run `npm run build` again to refresh the copy. If the new release adds `POST` operations that only read data, add them to `READ_ONLY_POSTS` in `src/spec.ts`.

## License

The code in this repository is released under the [MIT License](LICENSE). The VSP 360 OpenAPI definition in `spec/` describes Hitachi Vantara's product API and is not covered by this license.
