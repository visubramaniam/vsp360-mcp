# The vsp360-community Claude plugin

**vsp360-community** is a Claude plugin for **Hitachi VSP 360**. It installs the [vsp360-mcp](README.md) server, so Claude can work with VSP 360 through its REST API. It also adds three skills: **capacity and performance reports**, **Tufte-style charts** of that data, and a **platform health check**.

> Not an official Hitachi Vantara product: vsp360-mcp and this plugin are an independent, community project, and aren't supported by or affiliated with Hitachi Vantara. Hitachi and VSP 360 are trademarks of their owners.

- [Where it works](#where-it-works)
- [Before you start](#before-you-start)
- [Install](#install)
- [Configure](#configure)
- [Use](#use)
- [Update, disable and uninstall](#update-disable-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)

## Where it works

| Where | Works? |
|---|---|
| **Claude Code**: terminal, IDE extensions, and the desktop app's Code tab | Yes |
| **Cowork**, in sessions that run on your computer | Partly. Cowork doesn't prompt for settings, and the server needs the URL, client ID and secret, so it only starts there if they're already set. This hasn't been tested |
| **Claude chat**: claude.ai, and chat in the desktop and mobile apps | No: chat doesn't run plugins' local servers. For Claude Desktop chat, install the [`.mcpb` extension](INSTALL.md#claude-desktop-extension-mcpb) instead |

## Before you start

- **Claude Code.** The one-line `/plugin install … --marketplace …` form needs v2.1.275 or later; on older versions, add the marketplace first, as shown below.
- **Node.js 20 or later, with npm.** Claude Code uses npm to install the server's packages, and Node.js runs the server.
- **A VSP 360 service account,** with its client ID and secret. Give it only the access you need: `admin` covers alerts, logs and system operations; for devices, add it to a group whose access policy covers the device types. For reporting, read access is enough.
- **HTTPS access** from your computer to VSP 360. If its certificate comes from a private CA, have the CA's PEM file ready.

## Install

In a Claude Code session, run:

```
/plugin install vsp360-community --marketplace visubramaniam/vsp360-mcp
```

Or from your shell:

```bash
claude plugin marketplace add visubramaniam/vsp360-mcp
```

```bash
claude plugin install vsp360-community@vsp360-community
```

Claude Code downloads the plugin from GitHub. It then installs the server's packages from the plugin's lockfile: `vsp360-mcp` and its dependencies, each pinned to an exact version and checked against an integrity hash. No install scripts run.

Once the plugin is listed in Anthropic's plugin directory, you'll also be able to add it from **Customize → Plugins** on claude.ai, or with `/plugin directory` in Claude Code.

## Configure

The plugin needs three settings; the rest are optional.

| Setting | Key | Required | Notes |
|---|---|---|---|
| VSP 360 URL | `url` | yes | e.g. `https://vsp360.example.com` |
| Client ID | `client_id` | yes | The service account's client ID |
| Client secret | `client_secret` | yes | Kept in your system's secure credential store, not in a settings file |
| Direct toolsets | `toolsets` | no | API areas to expose as direct tools (see [Use](#use)) |
| Allow writes | `allow_writes` | no | Off by default. Leave it off unless Claude should change VSP 360 |
| CA certificate | `ca_cert` | no | Path to the PEM file of the CA that signed VSP 360's certificate |
| Skip TLS verification | `insecure_tls` | no | For lab systems with self-signed certificates only |
| Download folder | `download_dir` | no | Defaults to `~/Downloads/vsp360-mcp` |
| Upload folder | `upload_dir` | no | The only folder uploads may come from; read-only mode refuses uploads without it |

**In Claude Code**, run `/plugin configure vsp360-community@vsp360-community`. It shows each setting and asks for the values. The client secret's input is masked.

**From your shell**, set the non-secret values when installing:

```bash
claude plugin install vsp360-community@vsp360-community --config url=https://vsp360.example.com --config client_id=my-service-account
```

Then set the secret in `/plugin configure`. Passing it with `--config` would leave it in your shell history.

To see which settings are still unset, run:

```bash
claude plugin configure vsp360-community@vsp360-community
```

Start a new Claude Code session, or run `/reload-plugins`, after changing settings.

## Use

Ask in plain language. Claude finds the right VSP 360 API operation, checks its parameters and calls it:

- *"What alerts are firing right now?"*
- *"List the registered storage systems and their status."*
- *"Which pools are above 80% used, and how fast are they growing?"*
- *"Show the busiest volumes over the last 24 hours."*
- *"Save the device inventory as inventory.csv."*

### The skills

The plugin's three skills guide Claude through common tasks. Claude uses them when your request fits:

| Skill | Use it for | Example |
|---|---|---|
| `vsp360-capacity-report` | Capacity and performance reports and planning, through VSP 360 Analytics: pool usage, growth, over-commitment, data reduction, busiest volumes and ports, latency | *"Give me a capacity report for all pools, with 30-day growth."* |
| `vsp360-tufte-charts` | Charts in the style of Edward Tufte, saved as one self-contained HTML file: sparkline tables, capacity run-out forecasts, small multiples of MP, port or parity-group load, slopegraphs, IOPS-versus-latency scatters, latency distributions and capacity breakdowns | *"Chart pool usage for the last 45 days, with run-out dates."* |
| `vsp360-health-check` | A quick status of the platform, active alerts, devices not in a normal state, and failed jobs | *"Run a health check on VSP 360."* |

All three are read-only. To start one by name, type `/vsp360-community:vsp360-capacity-report`, `/vsp360-community:vsp360-tufte-charts` or `/vsp360-community:vsp360-health-check`.

### Direct tools for the areas you use most

By default, Claude reaches every operation through three discovery tools: search, describe and call. To let it call the operations in some API areas directly, set **Direct toolsets**. For capacity and performance work, for example:

```
Analytics / Query API,Device Registry,Usage and Billing Reports
```

The [wiki's Configuration page](https://github.com/visubramaniam/vsp360-mcp/wiki/Configuration) lists every area. Avoid `all`, which adds a few hundred tool definitions to every conversation.

### Read-only by default

Operations that change VSP 360 are refused before any request is sent, unless you turn on **Allow writes**. Leave it off for reporting and monitoring. If you turn it on, Claude Code still asks you before each tool call unless you've allowed it.

To see everything the plugin adds, and its approximate token cost, run:

```bash
claude plugin details vsp360-community@vsp360-community
```

## Update, disable and uninstall

| To | In your shell | Or in Claude Code |
|---|---|---|
| Update to the latest version | `claude plugin update vsp360-community@vsp360-community`, then restart Claude Code | `/plugin` → **Installed** |
| Turn it off for now | `claude plugin disable vsp360-community@vsp360-community` | `/plugin` → **Installed** |
| Turn it back on | `claude plugin enable vsp360-community@vsp360-community` | `/plugin` → **Installed** |
| Remove it | `claude plugin uninstall vsp360-community@vsp360-community` | `/plugin` → **Installed** |

Each plugin version installs a matching `vsp360-mcp` version. [CHANGELOG.md](CHANGELOG.md) lists what changed.

## Troubleshooting

| Problem | What to do |
|---|---|
| `/plugin` says the plugin's packages aren't installed | Make sure `npm` is on your `PATH`, then run `claude plugin update vsp360-community@vsp360-community`. Claude Code retries the install, which has a 60-second limit. On a restricted network, allow access to `registry.npmjs.org` |
| The `vsp360` server fails to start with "Missing required environment variables" | URL, client ID or secret isn't set. Run `/plugin configure vsp360-community@vsp360-community` |
| `unable to get local issuer certificate` | Set **CA certificate** to your CA's PEM file. Use **Skip TLS verification** on lab systems only |
| `Token request failed (HTTP 401)` | Wrong client ID or secret, or the service account is disabled |
| `HTTP 403` on a request | The service account lacks permission for that operation |
| "changes VSP 360 state and the server is running read-only" | Expected. Turn on **Allow writes** only if you mean to make changes |
| The tools don't appear in Cowork | Cowork doesn't prompt for the plugin's settings, so the server can't start without them. Use Claude Code |

The [wiki's Troubleshooting page](https://github.com/visubramaniam/vsp360-mcp/wiki/Troubleshooting) covers more. To report a problem, open a [GitHub issue](https://github.com/visubramaniam/vsp360-mcp/issues) with the plugin version and the error, and remove secrets and identifying details first.

## Privacy

The plugin and its server run on your computer. Nobody operates a service behind them, and the plugin's author receives no data.

- **What it collects:** nothing. There's no telemetry, analytics or tracking.
- **Where requests go:**
  - **Your VSP 360,** at the URL you configure. The server signs in with your service account's client ID and secret (OAuth client credentials) and sends the API requests Claude makes.
  - **The npm registry,** only when Claude Code installs or updates the plugin, to download the pinned packages.
  - Nothing else.
- **What Claude sees:** the API responses for the requests it makes, which become part of your conversation. Anthropic handles that under the terms of your Claude account.
- **What's stored on your computer:**
  - **The client secret,** in your system's secure credential store.
  - **The other settings,** in Claude Code's settings.
  - **Files you ask Claude to download or save,** in the download folder.
  - **An optional decision log,** only if you set it up outside the plugin. It records search and tool-call metadata, never credentials or response data.
- **Credentials:** never written to logs, tool output or files.

Report security problems privately, as [SECURITY.md](SECURITY.md) describes, rather than in a public issue.
