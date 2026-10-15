# Hitachi VSP 360 (Community)

A community plugin that connects Claude to **Hitachi VSP 360** through its REST API. Ask in plain language about alerts, cluster health, registered devices, capacity and performance, logs, data protection and users; Claude finds the right API operation and calls it for you.

> **Not an official Hitachi Vantara product.** This plugin and the [vsp360-mcp](https://github.com/visubramaniam/vsp360-mcp) server it runs are an independent, community project, not supported by or affiliated with Hitachi Vantara. Hitachi and VSP 360 are trademarks of their owners.

## What's in the plugin

- **An MCP server, `vsp360`:** the [`vsp360-mcp`](https://www.npmjs.com/package/vsp360-mcp) npm package, pinned to an exact version. It gives Claude access to all 264 operations of the VSP 360 1.4 REST API through three discovery tools (`vsp360_list_operations`, `vsp360_describe_operation`, `vsp360_call_operation`), plus direct tools for any API areas you choose.
- **Two skills:**
  - `vsp360-capacity-report`: capacity and performance reports and planning, using VSP 360 Analytics.
  - `vsp360-health-check`: a quick health check of the platform and its devices.

## Install

In Claude Code, install it from this repository's marketplace:

```
/plugin install vsp360-community --marketplace visubramaniam/vsp360-mcp
```

Claude Code then asks for the settings below. Once the plugin is listed in Anthropic's plugin directory, you'll also be able to add it from there.

## Where it works

The MCP server runs locally on your computer, so the plugin works in **Claude Code** and in **Cowork** sessions that run on your computer. Claude chat (web, desktop and mobile) doesn't run local MCP servers; for Claude Desktop chat, install the `.mcpb` extension from the project's [releases](https://github.com/visubramaniam/vsp360-mcp/releases) instead.

## Requirements

- **Node.js 20 or later.** The server is started with `npx`.
- **A VSP 360 service account** with the access you need. `admin` covers alerts, logs and system operations; for devices, add the account to a group whose access policy covers the device types.
- **HTTPS access** from your computer to VSP 360.

## Settings

When you enable the plugin, Claude Code asks for:

| Setting | Required | Notes |
|---|---|---|
| VSP 360 URL | yes | e.g. `https://vsp360.example.com` |
| Client ID | yes | The service account's client ID |
| Client secret | yes | Stored in your system's secure credential store, not in a settings file |
| Direct toolsets | no | API areas to expose as direct tools, e.g. `Analytics / Query API,Device Registry,Usage and Billing Reports` |
| Allow writes | no | Off by default. Leave it off unless you want Claude to change VSP 360 |
| CA certificate | no | PEM file of the CA that signed VSP 360's certificate |
| Skip TLS verification | no | Lab systems with self-signed certificates only |
| Download folder | no | Defaults to `~/Downloads/vsp360-mcp` |
| Upload folder | no | The only folder uploads may come from; read-only mode refuses uploads without it |

## What it runs, sends and stores

- **Runs:** `npx -y vsp360-mcp@<version>`. On first use, npm downloads that exact package and its dependencies from the npm registry.
- **Sends:** requests only to the VSP 360 URL you configure. It signs in with the service account's client ID and secret (OAuth client credentials) and sends the API requests Claude makes. Nothing is sent to the plugin's author or any other third party.
- **Returns to Claude:** the API responses, which become part of your conversation with Claude and are handled under your Claude account's terms.
- **Stores:** files you ask it to download or save, in the download folder. It keeps no other data. An optional local decision log is off unless you configure it outside the plugin.
- **Credentials:** never written to logs, tool output or files.

## Safety

- **Read-only by default.** Operations that change VSP 360 are refused before any request is sent unless you turn on **Allow writes**.
- **The one read that returns a live client secret** is refused unless explicitly allowed.
- **Downloads** stay in one folder and never overwrite files. **Uploads** refuse hidden files and folders, and in read-only mode need an upload folder.
- **TLS certificates** are verified unless you turn verification off.

See [SECURITY.md](https://github.com/visubramaniam/vsp360-mcp/blob/main/SECURITY.md) for the full security model, and how to report a vulnerability privately.

## Documentation and support

- Installation and configuration: [INSTALL.md](https://github.com/visubramaniam/vsp360-mcp/blob/main/INSTALL.md) and the [wiki](https://github.com/visubramaniam/vsp360-mcp/wiki)
- Questions and bugs: [GitHub issues](https://github.com/visubramaniam/vsp360-mcp/issues)

## License

MIT. See [LICENSE](LICENSE).
