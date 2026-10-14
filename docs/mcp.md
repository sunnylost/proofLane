# MCP client setup

ProofLane provides a local stdio MCP server. Install the packed package into a dedicated tool directory and install the desired analyzers in the target repository. No npm publication is required.

From a ProofLane source checkout:

```sh
npm ci
npm pack
```

In an independent installation directory:

```sh
npm install --omit=dev /path/to/sunnylost-prooflane-0.1.2.tgz
```

Use the absolute path to that installation's `node_modules/@sunnylost/prooflane/dist/cli.js` and the target Git repository. For Codex, replace both placeholders in this configuration:

```toml
[mcp_servers.prooflane]
command = "node"
args = ["/absolute/tool-install/node_modules/@sunnylost/prooflane/dist/cli.js", "mcp", "--root", "/absolute/target-repository"]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 150
```

The client timeout leaves room for the server's maximum requested analyzer timeout (120 seconds) and cleanup. If Node is not on the client's PATH, use the absolute path to the installed Node binary. Changing repositories requires restarting the server with the new root.

Codex also supports registration through `codex mcp add prooflane -- node ... mcp --root ...`. This changes the client's saved settings; the automated acceptance uses per-invocation configuration instead and leaves global settings untouched. Check the client tool catalog after connecting: `check_changes`, `check_project`, and `explain` should be available.

Non-interactive `codex exec` cannot show approval prompts. In an automation where the user has already authorized these checks, explicitly allow only these tools and preapprove them for that invocation:

```toml
[mcp_servers.prooflane]
enabled_tools = ["check_changes", "check_project", "explain"]

[mcp_servers.prooflane.tools.check_changes]
approval_mode = "approve"
[mcp_servers.prooflane.tools.check_project]
approval_mode = "approve"
[mcp_servers.prooflane.tools.explain]
approval_mode = "approve"
```

Merge these fields into the existing server table. Keep the client's workspace sandbox enabled. Verification runs project-installed analyzers and writes local evidence, so it is not advertised as read-only. Without advance authorization, retain the client's approval flow. If the client reports “requires approval, but approval policy is never”, no verification has executed; do not treat it as a tool result.

For clients that use JSON MCP configuration, the equivalent entry is:

```json
{
  "mcpServers": {
    "prooflane": {
      "command": "node",
      "args": ["/absolute/tool-install/node_modules/@sunnylost/prooflane/dist/cli.js", "mcp", "--root", "/absolute/target-repository"]
    }
  }
}
```

## Thin workflow skill

The package includes `skills/prooflane/SKILL.md`. Copy the `prooflane` directory into the client's project skill directory (for Codex, `.agents/skills/`) or explicitly provide its path. The skill guides check → explain → repair → recheck; it does not choose analyzers or interpret their raw protocols. Baseline acceptance remains a separate, explicit decision.

## Cancellation

Clients can cancel an active MCP request with the protocol cancellation notification. The server aborts its analyzers and keeps the connection available. Closing stdin cancels active work and waits for cleanup before exiting. A client timeout or interrupted turn is not successful verification.

SDK-based E2E exercises cancellation and continued use of the same connection. Real Codex acceptance separately records actual MCP calls during repair and an interrupted running check; see the implementation plan for the completed run and its limitations.

Configuration fields follow [OpenAI's MCP documentation](https://developers.openai.com/codex/mcp).
