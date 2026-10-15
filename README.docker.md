# Running vsp360-mcp with Docker

vsp360-mcp is a community MCP server for Hitachi VSP 360. It isn't an official Hitachi Vantara product.

`vsp360-mcp` is also published as a container image. Running it this way means you don't need to install Node.js or build anything; all you need is Docker.

```
docker.io/subramaniamv/vsp360-mcp
```

From version 0.1.18, the same image is also on GitHub Container Registry. Use it in place of the Docker Hub name in any command below, for example where Docker Hub's pull rate limits get in the way:

```
ghcr.io/visubramaniam/vsp360-mcp
```

The image runs the same server described in the [main README](README.md), with the VSP 360 1.4 OpenAPI spec bundled in. It is built for `linux/amd64` and `linux/arm64`, so it runs natively on Intel and Apple silicon Macs, Windows (WSL 2) and Linux.

## 1. Prerequisites

- **Docker** — Docker Desktop on macOS/Windows, or Docker Engine on Linux.
- **A VSP 360 service account.** Create one in VSP 360 and note its client ID and secret. Give it the access your use case needs: `admin` covers alerts, logs and system operations; for devices, add it to a group whose access policy covers the device types.
- **Network access** from the machine running Docker to your VSP 360 over HTTPS.

## 2. Download the image

```bash
docker pull docker.io/subramaniamv/vsp360-mcp:latest
```

To pin a version instead of `latest`, use a release tag, for example `:0.1.22`.

## 3. Test it from the command line

This checks that the container can sign in to VSP 360 before you connect Claude. Fill in your VSP 360 details:

```bash
docker run -i --rm -e VSP360_URL=https://vsp360.example.com -e VSP360_CLIENT_ID=my-service-account -e VSP360_CLIENT_SECRET=REPLACE_ME -e VSP360_INSECURE_TLS=true docker.io/subramaniamv/vsp360-mcp:latest
```

You should see:

```
[vsp360-mcp] ready: 264 operations, 0 direct tools, read-only
```

The server then waits for MCP messages on standard input. Press **Ctrl+C** to stop it. Only use `VSP360_INSECURE_TLS=true` if your VSP 360 has a self-signed certificate; see [TLS certificates](#tls-certificates) below.

## 4. Connect it to Claude

Claude starts the container itself, once per session, with `docker run -i --rm`. Both of these flags are required:
- `-i` keeps standard input open, which is how Claude talks to the server.
- `--rm` removes the container when the session ends.

### Claude Desktop

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
2. Add a `vsp360` entry **inside** `mcpServers`:

```json
{
  "mcpServers": {
    "vsp360": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "VSP360_URL",
        "-e", "VSP360_CLIENT_ID",
        "-e", "VSP360_CLIENT_SECRET",
        "-e", "VSP360_TOOLSETS",
        "-e", "VSP360_INSECURE_TLS",
        "-v", "/Users/YOU/Downloads/vsp360-mcp:/downloads",
        "docker.io/subramaniamv/vsp360-mcp:latest"
      ],
      "env": {
        "VSP360_URL": "https://vsp360.example.com",
        "VSP360_CLIENT_ID": "my-service-account",
        "VSP360_CLIENT_SECRET": "REPLACE_ME",
        "VSP360_TOOLSETS": "Device Registry,Platform Alerts,VSP 360 Cluster Health",
        "VSP360_INSECURE_TLS": "false"
      }
    }
  }
}
```

3. Quit Claude fully and reopen it. On a Mac, use **Claude → Quit Claude** from the menu bar.

The values go in `env`, and `args` only lists the variable names (`-e VSP360_CLIENT_SECRET` with no `=value`). Docker then copies each value from the environment Claude starts it with. This keeps the secret out of the process list, where `ps` would otherwise show it.

**If Claude reports that `docker` can't be found**, Claude Desktop isn't seeing your shell's `PATH`. Replace `"docker"` with the full path, which you can find by running `which docker`. It's usually `/usr/local/bin/docker`, or `/opt/homebrew/bin/docker` with Homebrew.

### Claude Code

```bash
claude mcp add vsp360 -e VSP360_URL=https://vsp360.example.com -e VSP360_CLIENT_ID=my-service-account -e VSP360_CLIENT_SECRET=REPLACE_ME -e "VSP360_TOOLSETS=Device Registry,Platform Alerts" -- docker run -i --rm -e VSP360_URL -e VSP360_CLIENT_ID -e VSP360_CLIENT_SECRET -e VSP360_TOOLSETS -v "$HOME/Downloads/vsp360-mcp:/downloads" docker.io/subramaniamv/vsp360-mcp:latest
```

Run `claude mcp list` to check that `vsp360` shows as connected.

### Check that it works

In a new conversation, ask Claude:

1. *"List the VSP 360 API areas"*. This needs no VSP 360 permissions, so it confirms the container started.
2. *"Show current VSP 360 platform alerts"*. This confirms that sign-in and network access work.

## 5. Files: downloads, uploads and certificates

The container can only see folders you mount into it with `-v host-folder:container-folder`. When you ask Claude to work with a file, use the path **inside the container**.

| What | Mount | Path to use in requests |
|---|---|---|
| Downloads (diagnostic bundles, CSR ZIPs, billing reports, CSV exports) | `-v /Users/YOU/Downloads/vsp360-mcp:/downloads` | Saved to `/downloads`, which appears in the host folder |
| Uploads (bulk-registration CSV, TLS certificate, upgrade package) | `-v /Users/YOU/vsp360-uploads:/uploads:ro` plus `-e VSP360_UPLOAD_DIR=/uploads` | `/uploads/devices.csv` |
| Decision log (optional) | `-v /Users/YOU/vsp360-logs:/logs` plus `-e VSP360_DECISION_LOG=/logs/decisions.jsonl` | Written to `/logs`, which appears in the host folder |
| Private CA certificate | `-v /Users/YOU/certs/vsp360-ca.pem:/certs/ca.pem:ro` plus `-e VSP360_CA_CERT=/certs/ca.pem` | n/a |

Create the host folders before starting Claude. If Docker creates a missing host folder itself, it may be owned by root, and the container (which runs as user `node`, UID 1000) won't be able to write to it.

On Docker Desktop for Mac and Windows, folders under your home directory are shared by default. Anything else must be added under **Settings → Resources → File sharing**.

## 6. TLS certificates

VSP 360 is often installed with a self-signed certificate. If so, the container will refuse to connect with an error like `unable to get local issuer certificate`. There are two fixes:

- **Recommended:** mount the CA certificate that signed VSP 360's certificate and set `VSP360_CA_CERT`, as shown in the table above.
- **Lab systems only:** set `VSP360_INSECURE_TLS=true`, which turns off certificate checking.

## 7. Configuration

All the [environment variables in the main README](README.md#configuration) work in the container. Pass each one with `-e NAME` in `args` and give its value in `env`. The settings you'll use most:

| Variable | Default | Notes |
|---|---|---|
| `VSP360_URL` | *(required)* | `https://<vsp360-host>` |
| `VSP360_CLIENT_ID` / `VSP360_CLIENT_SECRET` | *(required)* | Service account credentials |
| `VSP360_TOOLSETS` | *(none)* | API areas to expose as direct tools, comma-separated. Avoid `all`, which adds 264 tools and about 400 KB of tool definitions to every conversation. |
| `VSP360_ALLOW_WRITES` | `false` | Set to `true` to allow operations that change VSP 360 |
| `VSP360_CA_CERT` | | Path *inside the container* to a CA certificate |
| `VSP360_INSECURE_TLS` | `false` | Skips certificate checking; use on lab systems only |
| `VSP360_DOWNLOAD_DIR` | `/downloads` | Already set in the image; mount a folder here. Downloads and `save_to` files are written only inside it. |
| `VSP360_UPLOAD_DIR` | *(any non-hidden path)* | Path *inside the container* that uploads must come from, e.g. `/uploads`. In read-only mode, uploads are refused unless it's set. |
| `VSP360_ALLOW_SECRET_READS` | `false` | Allow the three operations that return a live client secret |
| `VSP360_DECISION_LOG` | *(off)* | Path *inside the container* to a JSON Lines file recording how search results are used; mount a folder for it (see [Files](#5-files-downloads-uploads-and-certificates)) |
| `VSP360_DECISION_HINT` | `false` | `true` adds a learned suggested next step to search results; `ab` does so in a random half of sessions |
| `VSP360_SPEC` | bundled 1.4 spec | Use a different OpenAPI file (see below) |

### Using a newer VSP 360 spec

Mount the new file and point the server at it:

```
-v /Users/YOU/specs/vsp360-openapi-1.5.yaml:/spec/vsp360.yaml:ro -e VSP360_SPEC=/spec/vsp360.yaml
```

## 8. Updating

```bash
docker pull docker.io/subramaniamv/vsp360-mcp:latest
```

Then restart Claude. The next session starts a container from the new image.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server doesn't appear in Claude | The JSON config is invalid, or the `vsp360` entry is outside `mcpServers`. Run `python3 -m json.tool` on the file to check it. |
| `docker: command not found` | Claude can't see your `PATH`. Use the full path to `docker`. |
| `Missing required environment variables` | A variable is in `env` but its `-e NAME` is missing from `args`, or the other way round. |
| `unable to get local issuer certificate` | VSP 360 has a self-signed certificate. See [TLS certificates](#tls-certificates). |
| `Token request failed (HTTP 401)` | Wrong client ID or secret, or the service account is disabled. |
| `ENOTFOUND` / `ECONNREFUSED` | The container can't reach VSP 360. Check DNS and firewalls from the Docker host. A VSP 360 on the Docker host itself is `https://host.docker.internal`. |
| `EACCES` when saving a download | The mounted host folder isn't writable by UID 1000. Create it yourself before starting. |
| `File not found` on upload | Use the path inside the container (`/uploads/...`), not the host path. |

To see the server's own log messages, run the test command from step 3. They go to standard error, which Claude Desktop also writes to `~/Library/Logs/Claude/mcp-server-vsp360.log`.

## Building the image yourself

From a clone of this repository:

```bash
docker build -t vsp360-mcp:local .
```

Then use `vsp360-mcp:local` in place of `docker.io/subramaniamv/vsp360-mcp:latest` in the commands above. To publish your own multi-architecture image:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t docker.io/YOUR_USER/vsp360-mcp:0.1.0 -t docker.io/YOUR_USER/vsp360-mcp:latest --push .
```
