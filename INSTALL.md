# Installing vsp360-mcp

vsp360-mcp is a community MCP server for Hitachi VSP 360. It isn't an official Hitachi Vantara product.

This guide covers installing and deploying the server. For what the server does and every setting it takes, see the [README](README.md).

- [Before you start](#before-you-start)
- [Choose an install method](#choose-an-install-method)
- [Claude Desktop extension (.mcpb)](#claude-desktop-extension-mcpb)
- [Standalone package](#standalone-package)
- [Claude Code plugin](#claude-code-plugin)
- [npm package](#npm-package)
- [Docker](#docker)
- [From source](#from-source)
- [Connect it to Claude](#connect-it-to-claude)
- [CI/CD pipelines](#cicd-pipelines)
- [Check that it works](#check-that-it-works)
- [Upgrading and uninstalling](#upgrading-and-uninstalling)

## Before you start

You need:

- **A VSP 360 service account.** Create one in VSP 360 and note its client ID and secret. Give it the access your use case needs: `admin` covers alerts, logs and system operations; for devices, add it to a group whose access policy covers the device types.
- **Network access** over HTTPS from the machine running the server to your VSP 360.
- **The CA certificate**, if VSP 360 uses a certificate signed by a private CA. You'll set it with `VSP360_CA_CERT`. On lab systems with a self-signed certificate you can use `VSP360_INSECURE_TLS=true` instead, which turns off certificate checking.

Every method takes the same three required settings: `VSP360_URL`, `VSP360_CLIENT_ID` and `VSP360_CLIENT_SECRET`. The server is read-only until you set `VSP360_ALLOW_WRITES=true`.

## Choose an install method

All packages are on the [GitHub releases page](https://github.com/visubramaniam/vsp360-mcp/releases). The commands below use version 0.1.23; replace it with the release you want.

| Method | Needs | Best for |
|---|---|---|
| [Claude Desktop extension](#claude-desktop-extension-mcpb) | Claude Desktop | Claude Desktop users. One click, no other software. |
| [Standalone package](#standalone-package) | nothing | Servers and workstations without Node.js; Claude Code. |
| [Claude Code plugin](#claude-code-plugin) | Claude Code, Node.js 20 or later | Claude Code and Cowork: the server plus capacity and health-check skills, with guided settings. |
| [npm package](#npm-package) | Node.js 20 or later | Machines that already have Node.js; CI/CD pipelines. Installed from the npm registry. |
| [Docker](#docker) | Docker | Isolated or containerised deployments. |
| [From source](#from-source) | Node.js 22 or later, git | Development. |

### Verify your download

Each release has a `SHA256SUMS` file. Download it into the same folder as the package, then check it.

macOS or Linux:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Windows (PowerShell): compare this output with the package's line in `SHA256SUMS`:

```powershell
Get-FileHash .\vsp360-mcp-0.1.23-win-x64.zip -Algorithm SHA256
```

## Claude Desktop extension (.mcpb)

1. Download `vsp360-mcp-0.1.23.mcpb`.
2. Open it, either by double-clicking it or by dragging it onto Claude Desktop.
3. Click **Install**, then fill in the settings:
   - **VSP 360 URL**, **Client ID** and **Client secret** are required. Claude Desktop treats the secret as sensitive and doesn't show it again.
   - **Direct toolsets**: optional API areas to expose as their own tools, e.g. `Device Registry,Platform Alerts`.
   - **Allow writes**: leave off for read-only access.
   - **CA certificate** or **Skip TLS verification**, if needed (see [Before you start](#before-you-start)).
   - **Download folder**: where downloaded files are saved. The default is `~/Downloads/vsp360-mcp`.
   - **Upload folder**: the only folder files may be uploaded from, such as bulk-registration CSVs. In read-only mode, uploads are refused unless it's set.
4. Enable the extension.

The extension runs with the Node.js built into Claude Desktop. To change a setting later, go to **Settings → Extensions → Hitachi VSP 360 (Community)**.

## Standalone package

Each standalone package contains the server and its own Node.js runtime. Download the one for your system:

| System | Package |
|---|---|
| macOS, Apple silicon | `vsp360-mcp-0.1.23-darwin-arm64.tar.gz` |
| macOS, Intel | `vsp360-mcp-0.1.23-darwin-x64.tar.gz` |
| Linux, x64 | `vsp360-mcp-0.1.23-linux-x64.tar.gz` |
| Linux, arm64 | `vsp360-mcp-0.1.23-linux-arm64.tar.gz` |
| Windows, x64 | `vsp360-mcp-0.1.23-win-x64.zip` |
| Windows, arm64 | `vsp360-mcp-0.1.23-win-arm64.zip` |

The Linux packages need glibc 2.28 or later (RHEL/Rocky 8+, Debian 10+, Ubuntu 20.04+). On Alpine Linux, use [Docker](#docker) or the [npm package](#npm-package) instead.

### macOS and Linux

Unpack the archive. To put the command on your `PATH`, symlink it:

```bash
sudo tar -xzf vsp360-mcp-0.1.23-linux-x64.tar.gz -C /opt
```

```bash
sudo ln -sf /opt/vsp360-mcp-0.1.23-linux-x64/bin/vsp360-mcp /usr/local/bin/vsp360-mcp
```

The server command is then `/usr/local/bin/vsp360-mcp`. The launcher follows the symlink to find its runtime, so the archive can live anywhere.

### Windows

Unzip the archive to a folder such as `C:\Program Files\vsp360-mcp`. This creates a `vsp360-mcp-0.1.23-win-x64` folder there. The server is started by its bundled `runtime\node.exe` running `dist\index.js`:

```powershell
& "C:\Program Files\vsp360-mcp\vsp360-mcp-0.1.23-win-x64\runtime\node.exe" "C:\Program Files\vsp360-mcp\vsp360-mcp-0.1.23-win-x64\dist\index.js"
```

From a Command Prompt you can also run `bin\vsp360-mcp.cmd`. In MCP client configs, use `node.exe` and `index.js` as shown in [Connect it to Claude](#connect-it-to-claude), because clients often can't start `.cmd` files directly.

## Claude Code plugin

The [`plugin/`](https://github.com/visubramaniam/vsp360-mcp/tree/main/plugin) folder is a Claude plugin, **vsp360-community**. It installs the server from its own lockfile (every package pinned with an integrity hash) and adds two skills: capacity and performance reports, and a health check. Install it in Claude Code from this repository's marketplace:

```
/plugin install vsp360-community --marketplace visubramaniam/vsp360-mcp
```

Claude Code asks for the VSP 360 URL, client ID and secret, and stores the secret in your system's secure credential store. The plugin works in Claude Code and in Cowork sessions on your computer. Claude Desktop **chat** doesn't run plugins' local servers, so use the [extension](#claude-desktop-extension-mcpb) there.

[README.plugin.md](README.plugin.md) covers the plugin in full: settings, the skills, updating, troubleshooting and privacy.

## npm package

The package is published on the npm registry as [`vsp360-mcp`](https://www.npmjs.com/package/vsp360-mcp), starting with version 0.1.17. It needs Node.js 20 or later.

```bash
npm install -g vsp360-mcp
```

This installs the `vsp360-mcp` command. To find its full path, which Claude Desktop needs, run `which vsp360-mcp` (`where vsp360-mcp` on Windows). To install a specific version, add it to the name, e.g. `npm install -g vsp360-mcp@0.1.23`.

To run it without a global install, use `npx`. Pin the version, so a new release isn't picked up without you knowing:

```bash
npx -y vsp360-mcp@0.1.23
```

With `npx`, the MCP client config uses `npx` as the command and `["-y", "vsp360-mcp@0.1.23"]` as the arguments.

Versions published by the Release workflow carry a signed [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) linking them to the GitHub commit and workflow run that built them. You can see it on the package's npm page.

**Without the npm registry.** If your machines can't reach registry.npmjs.org, every GitHub release also has the same package as a file, `vsp360-mcp-<version>.tgz`. Install it from its URL or from a downloaded copy:

```bash
npm install -g https://github.com/visubramaniam/vsp360-mcp/releases/download/v0.1.23/vsp360-mcp-0.1.23.tgz
```

Versions 0.1.16 and earlier are only available this way.

## Docker

The image `docker.io/subramaniamv/vsp360-mcp` is built for `linux/amd64` and `linux/arm64`. Each release is tagged with its version, and `latest` points at the newest release. From version 0.1.18, the same image is also published as `ghcr.io/visubramaniam/vsp360-mcp`.

```bash
docker pull docker.io/subramaniamv/vsp360-mcp:0.1.23
```

MCP clients start the container themselves with `docker run -i --rm`. The image is set up for this, so it doesn't run as a long-lived service. [README.docker.md](README.docker.md) covers the Claude configuration, mounting folders for downloads, uploads and certificates, and troubleshooting.

## From source

```bash
git clone https://github.com/visubramaniam/vsp360-mcp.git
```

```bash
cd vsp360-mcp && npm ci && npm run build
```

The server command is `node /ABSOLUTE/PATH/TO/vsp360-mcp/dist/index.js`. To build the release packages yourself, run `npm run package`; they're written to `release/`.

## Connect it to Claude

In these examples, `vsp360-mcp` is the server command. Replace it with the path from your install method:

| Install method | Command |
|---|---|
| Standalone, macOS/Linux | `/opt/vsp360-mcp-0.1.23-linux-x64/bin/vsp360-mcp`, or `/usr/local/bin/vsp360-mcp` if you made the symlink |
| Standalone, Windows | `C:\Program Files\vsp360-mcp\vsp360-mcp-0.1.23-win-x64\runtime\node.exe` with the argument `...\dist\index.js` |
| npm | the output of `which vsp360-mcp` |
| Source | `node` with the argument `/ABSOLUTE/PATH/TO/vsp360-mcp/dist/index.js` |
| Docker | see [README.docker.md](README.docker.md#4-connect-it-to-claude) |

### Claude Code

```bash
claude mcp add vsp360 -e VSP360_URL=https://vsp360.example.com -e VSP360_CLIENT_ID=my-service-account -e VSP360_CLIENT_SECRET=REPLACE_ME -e "VSP360_TOOLSETS=Device Registry,Platform Alerts" -- vsp360-mcp
```

Run `claude mcp list` to check that `vsp360` shows as connected.

### Claude Desktop

If you didn't use the [extension](#claude-desktop-extension-mcpb), edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add a `vsp360` entry inside `mcpServers`. Claude Desktop doesn't read your shell's `PATH`, so use full paths.

macOS or Linux:

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

Windows, standalone package (backslashes are doubled in JSON):

```json
{
  "mcpServers": {
    "vsp360": {
      "command": "C:\\Program Files\\vsp360-mcp\\vsp360-mcp-0.1.23-win-x64\\runtime\\node.exe",
      "args": ["C:\\Program Files\\vsp360-mcp\\vsp360-mcp-0.1.23-win-x64\\dist\\index.js"],
      "env": {
        "VSP360_URL": "https://vsp360.example.com",
        "VSP360_CLIENT_ID": "my-service-account",
        "VSP360_CLIENT_SECRET": "REPLACE_ME"
      }
    }
  }
}
```

Then quit Claude Desktop fully and reopen it. On a Mac, use **Claude → Quit Claude** from the menu bar.

### Other MCP clients

The server speaks MCP over standard input and output. Configure your client to start the server command with the environment variables above.

## CI/CD pipelines

In a pipeline, install a pinned version and pass the credentials from your CI secret store. Never put them in the repository.

This GitHub Actions example installs the server from the npm registry and writes an MCP config that an agent step, such as Claude Code with `--mcp-config vsp360.mcp.json`, can use. The config names only the variables; the values come from the job's environment.

```yaml
env:
  VSP360_VERSION: 0.1.23

steps:
  - name: Install vsp360-mcp
    run: npm install -g "vsp360-mcp@$VSP360_VERSION"

  - name: Write the MCP config
    run: |
      cat > vsp360.mcp.json <<'EOF'
      { "mcpServers": { "vsp360": { "command": "vsp360-mcp" } } }
      EOF

  - name: Run the agent step
    env:
      VSP360_URL: ${{ vars.VSP360_URL }}
      VSP360_CLIENT_ID: ${{ secrets.VSP360_CLIENT_ID }}
      VSP360_CLIENT_SECRET: ${{ secrets.VSP360_CLIENT_SECRET }}
    run: ...  # your step that uses vsp360.mcp.json
```

If the runner can't reach the npm registry, install the release's `.tgz` file instead, checked against the release's `SHA256SUMS`:

```bash
base=https://github.com/visubramaniam/vsp360-mcp/releases/download/v$VSP360_VERSION
curl -fsSLO "$base/vsp360-mcp-$VSP360_VERSION.tgz"
curl -fsSL "$base/SHA256SUMS" | grep " vsp360-mcp-$VSP360_VERSION.tgz$" | sha256sum -c -
npm install -g "./vsp360-mcp-$VSP360_VERSION.tgz"
```

The same steps work in other CI systems. If the runner has no Node.js, download the standalone package instead and use its `bin/vsp360-mcp`. If your pipeline runs jobs in containers, use the Docker image.

For automated jobs, keep the server read-only, which is the default, unless the job must change VSP 360. If the job only needs reads, give its service account only read access in VSP 360 too.

## Check that it works

**From the command line.** Start the server with your settings. This example uses the standalone or npm command:

```bash
VSP360_URL=https://vsp360.example.com VSP360_CLIENT_ID=my-service-account VSP360_CLIENT_SECRET=REPLACE_ME vsp360-mcp
```

You should see:

```
[vsp360-mcp] ready: 264 operations, 0 direct tools, read-only
```

The server then waits for MCP messages. Press **Ctrl+C** to stop it. The server signs in to VSP 360 only when it makes its first request, so this step doesn't test your credentials.

**In Claude.** In a new conversation, ask:

1. *"List the VSP 360 API areas"*. This needs no VSP 360 access, so it confirms the server started.
2. *"Show current VSP 360 platform alerts"*. This confirms that sign-in, TLS and network access work.

If something fails, the server's messages go to standard error. Claude Desktop writes them to `~/Library/Logs/Claude/mcp-server-vsp360.log` on macOS, or `%APPDATA%\Claude\logs\mcp-server-vsp360.log` on Windows. Common errors:

| Error | Cause |
|---|---|
| `Missing required environment variables` | `VSP360_URL`, `VSP360_CLIENT_ID` or `VSP360_CLIENT_SECRET` isn't set. |
| `unable to get local issuer certificate` | VSP 360's certificate isn't trusted. Set `VSP360_CA_CERT` (or `VSP360_INSECURE_TLS=true` on lab systems). |
| `Token request failed (HTTP 401)` | Wrong client ID or secret, or the service account is disabled. |
| `ENOTFOUND` / `ECONNREFUSED` | The machine can't reach VSP 360. Check DNS, proxies and firewalls. |

## Upgrading and uninstalling

| Method | Upgrade | Uninstall |
|---|---|---|
| Extension | Open the new `.mcpb` file and install it over the old version. Check your settings afterwards. | **Settings → Extensions → Hitachi VSP 360 (Community) → Uninstall** |
| Standalone | Unpack the new version next to the old one, repoint the symlink or config, then delete the old folder. | Delete the folder and the symlink. |
| npm | `npm install -g vsp360-mcp@latest`, or update the pinned version in your `npx` config | `npm uninstall -g vsp360-mcp` |
| Docker | `docker pull` the new tag, and update the tag in your Claude config if you pinned one. | `docker rmi docker.io/subramaniamv/vsp360-mcp:<tag>` |
| Source | `git pull && npm ci && npm run build` | Delete the folder. |

After upgrading, restart Claude Desktop or start a new Claude Code session so the new version is used. Check the [CHANGELOG](CHANGELOG.md) for changes that need action, such as removed operations or renamed files.
