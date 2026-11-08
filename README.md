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
  at the same time it watches the state Orca's agent hooks report, so a worker
  parked on a permission prompt (which never mails) wakes it too. Without a
  Run it waits on hook state alone.
- **Ownership that survives restarts.** Workers this server starts are tagged
  `orca-mcp:<tag>` in their Orca worktree comment (appended to an optional
  note you pass as `comment`), so with a stable `ORCA_MCP_CLIENT` they are
  found again through `orca worktree ps` after a restart. The tag lives only in
  that comment: if someone edits it away in Orca, the worker is no longer
  "mine" (it still shows with `scope: "all"`).

Every tool result starts with a `<state>: <summary>` line and carries the same
facts as `structuredContent`.

## Requirements

- Orca installed and running (tested with 1.4.250).
- Node.js 20 or newer.

## Install

Not on npm yet, so build it from a checkout:

```sh
git clone <this repo> orca-mcp && cd orca-mcp
pnpm install && pnpm build
```

The server is then `node /abs/path/to/orca-mcp/dist/server.js`. Register it
with your client (replace the path):

**Hermes Agent** (`--args` must come last)

```sh
hermes mcp add orca --env ORCA_MCP_ROOTS=$HOME/dev --command node --args /abs/path/to/orca-mcp/dist/server.js
```

or in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  orca:
    command: "node"
    args: ["/abs/path/to/orca-mcp/dist/server.js"]
    env:
      ORCA_MCP_ROOTS: "/Users/me/dev"
```

**Claude Code**

```sh
claude mcp add orca -e ORCA_MCP_ROOTS="$HOME/dev" -- node /abs/path/to/orca-mcp/dist/server.js
```

**Codex**

```sh
codex mcp add orca --env ORCA_MCP_ROOTS="$HOME/dev" -- node /abs/path/to/orca-mcp/dist/server.js
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.orca]
command = "node"
args = ["/abs/path/to/orca-mcp/dist/server.js"]
env = { ORCA_MCP_ROOTS = "/Users/me/dev" }
```

**After publish to npm**, the command becomes `npx -y orca-mcp`, e.g.
`hermes mcp add orca --command npx --args -y orca-mcp`,
`claude mcp add orca -- npx -y orca-mcp`, `codex mcp add orca -- npx -y orca-mcp`.

`SKILL.md` is an [Agent Skills](https://agentskills.io) file with the
coordinator loop; copy it into your client's skills folder (for Claude Code:
`~/.claude/skills/orca-mcp/SKILL.md`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORCA_BIN` | the CLI inside the installed Orca app, else `orca` on PATH | Path of the `orca` CLI. Looked up at `/Applications/Orca.app/Contents/Resources/bin/orca` (macOS), `~/.local/bin/orca` (Linux), `%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe` (Windows). |
| `ORCA_MCP_ROOTS` | `~/dev` | Directories repos and worktrees must lie in, separated by `:` (`;` on Windows). Paths are resolved through symlinks and `..` before the check. |
| `ORCA_MCP_CLIENT` | the MCP client's name plus a random per-process suffix | The owner tag written into worktrees this server starts (`orca-mcp:<tag>`), and the name the external coordinator identity is saved under. Without it each server process has its own tag, so "mine" and the external coordinator do not survive a restart of the server; set a stable value (for example one per project or daemon) to keep both. |
| `ORCA_MCP_BRIDGE` | on | `0` does not open the status socket for the companion plugin. |
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
| `orca_check` | List or wait for a Run's unread mail (always read with `--peek`, never taken), or wait on one terminal. Prefer `orca_wait`. |
| `orca_worker_read`, `orca_terminal_read` | A worker's output, by dispatch or terminal, with cursors. |
| `orca_terminal_send`, `orca_terminal_wait` | Low-level terminal input and waits. |
| `orca_worker_stop`, `orca_worktree_rm` | Stop an agent; remove a worktree (destructive). |
| `orca_search` | Search past agent conversations. |

## Push instead of polling (optional plugin)

`plugin/` is a companion Orca plugin (`trusted-worker`, asks for `agent:read` and
`workspace:read`). It forwards Orca's `agent.status.changed`, `workspace.created` and
`workspace.removed` events to every orca-mcp server of your user over a private local socket
(`<tmpdir>/orca-mcp-<uid>/<pid>.sock`, dir 0700, socket 0600). While it is connected, `orca_wait`
wakes on those events instead of reading `orca worktree ps` every 5 s, and `orca_agent_status`
says `via: "push"`. Without the plugin everything works by polling. Set `ORCA_MCP_BRIDGE=0` to
not open the socket at all. On Windows the bridge is off on both sides (named pipes are shared
between users, so another user could squat one) and orca-mcp polls. Loading the plugin is your call: Orca shows what it may do and asks
for approval (`orca plugin dev watch ./plugin`, see `plugin/README.md`).

## External coordinators

Released Orca coordinates an orchestration Run from a terminal pane, so a process
outside Orca cannot create one (`orca_run_create` is refused there; `orca_worker_start`
with a spec still works). Upstream work
([stablyai/orca#15828](https://github.com/stablyai/orca/issues/15828)) adds an external
coordinator identity. It needs an Orca build whose `orca status --json` lists the capability
`orchestration.external-coordinator.v1`; `orca_status` says `external coordinator supported`.

With that build, on its first coordinator call this server runs
`orca orchestration external-register --label <client tag>`. That returns an
`external:<id>` address and a one-time registration key. Every coordinator call
(`run-create`, `task-create`, `worker-start`, `check`, `send`) then carries
`ORCA_EXTERNAL_COORDINATOR=external:<id>` and `ORCA_EXTERNAL_COORDINATOR_KEY=<key>` in the
child process environment. The key never goes on a command line (where `ps` would show it)
and never appears in a tool result: results are scrubbed of it, and an argument that contains
it is refused. The parent's own `ORCA_EXTERNAL_COORDINATOR*` variables are never forwarded.

- **Restarts.** With `ORCA_MCP_CLIENT` set, `{id, key}` is kept in
  `external-coordinator-<tag>.json` under the per-user state dir
  (`~/Library/Application Support/orca-mcp` on macOS, `$XDG_STATE_HOME/orca-mcp` or
  `~/.local/state/orca-mcp` elsewhere; dir 0700, file 0600, owner-checked). After a restart
  the server resumes with `--resume external:<id>` and the stored key, which Orca rotates;
  the new key replaces the old one atomically. Without `ORCA_MCP_CLIENT` the identity lives
  only as long as the process.
- **Refusals.** A resume refused as unknown, not the owner or with a wrong key registers a
  fresh coordinator and rewrites the file. A later coordinator call refused the same way
  registers again on the next call.
- **Inside an Orca terminal.** If orca-mcp itself runs in an Orca terminal or agent session,
  Orca refuses (`external_from_agent_context`): an agent there acts only as itself. The
  server says so and uses today's behaviour.

Without the capability nothing registers and every call behaves exactly as before. The command
names and env names live in one adapter (`src/capabilities.ts`).

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
