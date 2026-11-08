# orca-mcp

An MCP server for [Orca](https://github.com/stablyai/orca), the desktop app for
fleets of coding agents. It lets any MCP client (Hermes Agent, Claude Code,
Codex, your own daemon) start agents in Orca worktrees, see what each of them is
doing, wait for them to finish and talk to them.

Orca ships a CLI but no MCP server and no public API. This package wraps the
CLI that comes with the app, so it works with today's unmodified Orca, and it
makes three things first-class that are awkward through the CLI alone:

- **Status.** `orca_agent_status` returns, per worker, its state (`working`,
  `waiting`, `blocked`, `done`, `idle`), since when, the tool it runs, what it
  waits on, its last message, and its terminal, dispatch and task ids, in one
  call.
- **Completion.** `orca_wait` blocks inside the server and returns one
  structured event when a worker finishes or needs a human. With an
  orchestration Run it waits on the Run's `worker_done` and `escalation` mail
  (read with `--peek`, so it never takes mail from the Run's coordinator);
  otherwise on the state Orca's agent hooks report.
- **Ownership that survives restarts.** Workers this server starts are tagged
  `orca-mcp:<client>` in their Orca worktree comment, so after a restart they
  are found again through `orca worktree ps`.

Every tool result starts with a `<state>: <summary>` line and carries the same
facts as `structuredContent`.

## Requirements

- Orca installed and running (tested with 1.4.250).
- Node.js 20 or newer.

## Install

The package is not on npm yet. Build it from a checkout:

```sh
git clone <this repo> orca-mcp && cd orca-mcp
pnpm install && pnpm build
```

Then point your client at `node /abs/path/to/orca-mcp/dist/server.js`. Once
published, `npx -y orca-mcp` replaces that command in the lines below.

**Hermes Agent**

```sh
hermes mcp add orca -- npx -y orca-mcp
```

**Claude Code**

```sh
claude mcp add orca -e ORCA_MCP_ROOTS="$HOME/dev" -- npx -y orca-mcp
```

**Codex**

```sh
codex mcp add orca -- npx -y orca-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.orca]
command = "npx"
args = ["-y", "orca-mcp"]
env = { ORCA_MCP_ROOTS = "/Users/me/dev" }
```

`SKILL.md` is an [Agent Skills](https://agentskills.io) file with the
coordinator loop; copy it into your client's skills folder (for Claude Code:
`~/.claude/skills/orca-mcp/SKILL.md`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORCA_BIN` | the CLI inside the installed Orca app, else `orca` on PATH | Path of the `orca` CLI. Looked up at `/Applications/Orca.app/Contents/Resources/bin/orca` (macOS), `~/.local/bin/orca` (Linux), `%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe` (Windows). |
| `ORCA_MCP_ROOTS` | `~/dev` | Directories repos and worktrees must lie in, separated by `:` (`;` on Windows). Paths are resolved through symlinks and `..` before the check. |
| `ORCA_MCP_CLIENT` | the MCP client's name | The tag written into worktrees this server starts (`orca-mcp:<client>`). Set it per session to keep two sessions of the same client apart. |
| `ORCA_MCP_TMP_PREFIX` | unset | Also allow scratch directories directly under the per-user temp dir whose name starts with this prefix. The directory must exist, be owned by you and be writable by nobody else. |

The orca CLI runs with an argv array (never a shell), a minimal environment
(PATH, HOME and the few variables it needs to find its runtime), a timeout, a 1
MB output cap and a process-group kill. Arguments that look like credentials
are refused before anything runs.

## Tools

| Tool | What it does |
|---|---|
| `orca_status` | Is Orca running, its version, orchestration on or off, external coordinator support. |
| `orca_repos`, `orca_repo_add` | List repos registered in Orca, register one. |
| `orca_worktrees` | Worktrees with their live agents and owner tag; `mine: true` for this client's. |
| `orca_worktree_create` | New worktree plus an agent with a prompt (model and effort optional). |
| `orca_worker_start` | Orchestration worker on a task or spec in a new worktree; falls back to `orca_worktree_create` without orchestration. |
| `orca_agent_status` | Per-worker status in one call (see above). |
| `orca_wait` | Server-side wait for the next worker event (see above). |
| `orca_run_create`, `orca_task_create` | Orchestration Run and Task. |
| `orca_send` | Orchestration mail to a worker or Run, or a line typed into its terminal. |
| `orca_check` | Take a Run's mail, or wait on one terminal. Prefer `orca_wait`. |
| `orca_worker_read`, `orca_terminal_read` | A worker's output, by dispatch or terminal, with cursors. |
| `orca_terminal_send`, `orca_terminal_wait` | Low-level terminal input and waits. |
| `orca_worker_stop`, `orca_worktree_rm` | Stop an agent; remove a worktree (destructive). |
| `orca_search` | Search past agent conversations. |

## External coordinators

Today an Orca orchestration Run is coordinated from a terminal pane, so a
process outside Orca cannot create one. Upstream work
([stablyai/orca#15828](https://github.com/stablyai/orca/issues/15828)) adds an
external coordinator identity. When the runtime advertises the capability
`orchestration.external-coordinator.v1` (`orca status --json`), this server
registers itself with `orca orchestration external register` on first use and
passes `--from external:<id>` on coordinator calls. Without the capability it
behaves exactly as before. The command names live in one adapter
(`src/capabilities.ts`).

## Embedding

The handlers are exported, so a host can wrap them or serve them itself:

```ts
import { buildTools, createOrcaMcpServer, type ToolResult } from "orca-mcp";

const server = createOrcaMcpServer({
  onToolResult: (name, args, result: ToolResult) => {
    // e.g. count workers from result.structuredContent.worker, add markers,
    // or return a replacement result.
  },
});
```

`buildTools(deps)` returns `{ name, description, shape, handler }[]` for hosts
that register tools on their own server. `deps.run` swaps the CLI runner,
`deps.env` the environment, `deps.client` the owner tag.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Tests run against a fake `orca` binary and a scripted runner; they never touch
a live Orca.

## License

MIT
