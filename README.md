# vsp360-mcp

An MCP server for the **Hitachi VSP 360 1.4 REST API**, built from `spec/vsp360-openapi.yaml`. It gives Claude (or any other MCP client) access to all 264 API operations. The token endpoint is excluded because the server handles authentication itself.

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

## Safety: read-only by default

By default only `GET` operations are allowed, plus a few `POST` operations that only query or validate:
- analytics query
- inventory filter query
- authorization check
- user capabilities
- CSV validation
- upgrade version validation
- directory connection test

All other operations are refused, and direct tools are not created for them. These include device registration and deletion, orchestration workflows (volume allocation, GAD, NDM), user and group changes, certificates, upgrades and notifications. To allow them, set `VSP360_ALLOW_WRITES=true`. `DELETE` tools are marked `destructiveHint`, so Claude asks for confirmation before running them.

## Features

- **Auth:** Gets an OAuth2 `client_credentials` token from `POST /api/v1/vsp360/auth/token`. It reuses the token until shortly before it expires and fetches a new one automatically after a 401.
- **Pagination:** Use `limit` and `offset` (at most 100 per page), or set `all_pages: true` to follow the RFC 8288 `next` links. `max_pages` caps the number of pages and defaults to 20. The `Content-Range` and `Link` headers are included in each result.
- **Downloads:** Binary responses are saved to `VSP360_DOWNLOAD_DIR`, and the file path is returned. These include diagnostic bundles (`.tar.gz`), CSR ZIPs and billing reports. Any call can also pass `save_to: "/path/file"`.
- **Uploads:** Multipart operations take local file paths, for example `files: {"file": "~/devices.csv"}`. This applies to installing a TLS certificate, validating a bulk-registration CSV, and uploading an upgrade package. Files are streamed from disk, so 20 GB `.zst` upgrade packages don't need to fit in memory.
- **TLS:** Use `VSP360_CA_CERT` for a private CA. Use `VSP360_INSECURE_TLS=true` only for lab systems with self-signed certificates.
- **Large responses:** Responses longer than `VSP360_MAX_RESPONSE_CHARS` are truncated, with a note telling Claude how to narrow the request.

## Setup

1. Create a service account in VSP 360 and note its client ID and secret. Give it the access your use case needs: `admin` covers alerts, logs and system operations; for devices, use a group whose access policy covers the device types.
2. Build the server:

```bash
npm install && npm run build
```

### Claude Code

Replace `/ABSOLUTE/PATH/TO` with the folder's real path:

```bash
claude mcp add vsp360 -e VSP360_URL=https://vsp360.example.com -e VSP360_CLIENT_ID=my-service-account -e VSP360_CLIENT_SECRET=REPLACE_ME -e "VSP360_TOOLSETS=Device Registry,Platform Alerts" -- node /ABSOLUTE/PATH/TO/vsp360-mcp/dist/index.js
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vsp360": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/vsp360-mcp/dist/index.js"],
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
| `VSP360_TOOLSETS` | *(none)* | Comma-separated API areas (tags) to expose as direct tools. `all` exposes all 264, which is not recommended. |
| `VSP360_CA_CERT` | | PEM file of the CA that signed the VSP 360 certificate |
| `VSP360_INSECURE_TLS` | `false` | Skip TLS verification (lab use only) |
| `VSP360_TIMEOUT_MS` | `120000` | Request timeout; uploads are exempt |
| `VSP360_MAX_RESPONSE_CHARS` | `60000` | Truncation limit for text responses |
| `VSP360_DOWNLOAD_DIR` | `~/Downloads/vsp360-mcp` | Where binary downloads are saved |
| `VSP360_SPEC` | bundled spec | Path to a different OpenAPI file, e.g. a newer VSP 360 release |

## Tag names for `VSP360_TOOLSETS`

Users · Groups · Group Access · Service Accounts · Roles · Identity Providers · Active Directory · Authentication Settings · Authorization · Access Catalog · Access Policies · Privileged Access Management · Block Single Sign-On · Device Registration · Device Registry · Device Operation Jobs · File and Object Device Registration · Host and Hypervisor Discovery · Platform Alerts · VSP 360 Cluster Health · Logs · Diagnostics · Platform Profiles · Resource Management · Platform Upgrade · Application Lifecycle · TLS Certificates · Trusted CA Certificates · Notifications · Usage and Billing Reports · Product Information · Data Protection / Copies · Data Protection / Policies · Orchestration / Execute Workflows · Analytics / Query API

## Updating for a new VSP 360 release

Replace `spec/vsp360-openapi.yaml` and restart the server. No code is generated from the spec, so nothing needs rebuilding. If the new release adds `POST` operations that only read data, add them to `READ_ONLY_POSTS` in `src/spec.ts`.

## License

The code in this repository is released under the [MIT License](LICENSE). The VSP 360 OpenAPI definition in `spec/` describes Hitachi Vantara's product API and is not covered by this license.
