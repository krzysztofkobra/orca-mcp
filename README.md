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

Published on npm as `@krzysztofkobra/orca-mcp` (the bare `orca-mcp` name belongs to
another project); clients start it with `npx`. It needs Node 20+ and the Orca desktop app.

**Hermes Agent** (`--args` must come last)

```sh
hermes mcp add orca --env ORCA_MCP_ROOTS=$HOME/dev --command npx --args -y @krzysztofkobra/orca-mcp
```

or in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  orca:
    command: "npx"
    args: ["-y", "@krzysztofkobra/orca-mcp"]
    env:
      ORCA_MCP_ROOTS: "/Users/me/dev"
```

**Claude Code**

```sh
claude mcp add orca -e ORCA_MCP_ROOTS="$HOME/dev" -- npx -y @krzysztofkobra/orca-mcp
```

**Codex**

```sh
codex mcp add orca --env ORCA_MCP_ROOTS="$HOME/dev" -- npx -y @krzysztofkobra/orca-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.orca]
command = "npx"
args = ["-y", "@krzysztofkobra/orca-mcp"]
env = { ORCA_MCP_ROOTS = "/Users/me/dev" }
```

From a checkout instead: `git clone https://github.com/krzysztofkobra/orca-mcp && cd orca-mcp
&& pnpm install && pnpm build`, then use `node /abs/path/to/orca-mcp/dist/server.js` as the command.

`SKILL.md` is an [Agent Skills](https://agentskills.io) file with the
coordinator loop; copy it into your client's skills folder (for Claude Code:
`~/.claude/skills/orca-mcp/SKILL.md`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORCA_BIN` | the CLI inside the installed Orca app, else `orca` on PATH | Path of the `orca` CLI. Looked up at `/Applications/Orca.app/Contents/Resources/bin/orca` (macOS), `~/.local/bin/orca` (Linux), `%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe` (Windows). |
| `ORCA_MCP_ROOTS` | `~/dev` | Directories repos and worktrees must lie in, separated by `:` (`;` on Windows). Paths are resolved through symlinks and `..` before the check. |
| `ORCA_MCP_CLIENT` | the MCP client's name plus a random per-process suffix | The owner tag written into worktrees this server starts (`orca-mcp:<tag>`). Without it each server process has its own tag, so "mine" does not survive a restart of the server; set a stable value (for example one per project or daemon) to find your workers again after a restart. |
| `ORCA_MCP_ENVIRONMENT` | unset | Name (or id) of a saved Orca environment (`orca environment add`). When its Orca advertises `orchestration.external-coordinator.v1`, this server coordinates Runs as that paired device; see [External coordinators](#external-coordinators). Unset, everything works as before. |
| `ORCA_MCP_CLIENT_PROFILE` | unset | A profile directory of the coordinator's own, passed to the orca CLI as `ORCA_USER_DATA_PATH`. Needed when `ORCA_MCP_ENVIRONMENT` points at the Orca on this same computer, where the pairing cannot be saved in Orca's own profile. |
| `ORCA_MCP_BRIDGE` | on | `0` does not open the status socket for the companion plugin. |
| `ORCA_MCP_TMP_PREFIX` | unset | Also allow scratch directories directly under the per-user temp dir whose name starts with this prefix. The directory must exist, be owned by you and be writable by nobody else. |

The orca CLI runs with an argv array (never a shell), a minimal environment
(PATH, HOME and the few variables it needs to find its runtime), a timeout, a 1
MB output cap and a process-group kill. Arguments that look like credentials
are refused before anything runs.

## Tools

| Tool | What it does |
|---|---|
| `orca_status` | Is Orca running, its version, orchestration on or off, external coordinator on or off (and why). |
| `orca_repos`, `orca_repo_add` | List repos registered in Orca, register one. |
| `orca_worktrees` | Worktrees with their live agents and owner tag; `mine: true` for this client's. |
| `orca_worktree_create` | New worktree plus an agent with a prompt (model and effort optional). |
| `orca_worker_start` | Orchestration worker on a task or spec in a new worktree; falls back to `orca_worktree_create` without orchestration. |
| `orca_agent_status` | Per-worker status in one call (see above). |
| `orca_wait` | Server-side wait for the next worker event (see above). |
| `orca_run_create`, `orca_task_create` | Orchestration Run and Task. |
| `orca_send` | Orchestration mail to a worker or Run, or a line typed into its terminal. |
| `orca_check` | List or wait for a Run's unread mail (always read with `--peek`, never taken), or wait on one terminal. Prefer `orca_wait`. |
| `orca_worktree_show` | One worktree's details: branch, head, status, owner tag. |
| `orca_worker_read`, `orca_terminal_read` | A worker's output, by dispatch or terminal, with cursors; `tail` on a terminal for its last lines. |
| `orca_terminals` | Live terminals, filtered by worktree (path or name) and agent. |
| `orca_terminal_close` | Close one terminal, its tab, or every terminal of a worktree (`all: true`). |
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
([stablyai/orca#15828](https://github.com/stablyai/orca/issues/15828), PR pending) lets a
process outside any Orca terminal coordinate a Run as a saved, paired runtime environment:
the paired device is the identity, there is no token of its own. It needs an Orca build whose
`orca status --json` lists the capability `orchestration.external-coordinator.v1`.

Setup (you do the pairing by hand, once; orca-mcp never pairs and stores nothing):

1. Make a pairing link on the Orca host: `orca pair --address 127.0.0.1 --json` (its
   `pairingUrl`) when the coordinator runs on the same computer, or `orca pair` / Settings for
   another machine. `orca pair` also opens network access on that Orca.
2. Save it as an environment. On the same computer Orca refuses to save a pairing code into the
   profile of the runtime it points at, so the coordinator keeps a profile of its own:
   `ORCA_USER_DATA_PATH=~/.orca-coordinator orca environment add --name this-mac --pairing-code "orca://pair?code=..."`
   (on another machine plain `orca environment add ...` is enough).
3. Set `ORCA_MCP_ENVIRONMENT=this-mac` in the server's environment (the `env` of your MCP
   client config, as for `ORCA_MCP_ROOTS`), and on the same computer also
   `ORCA_MCP_CLIENT_PROFILE=~/.orca-coordinator` (orca-mcp passes it to the CLI as
   `ORCA_USER_DATA_PATH`).

`orca_status` then says `external coordinator on (environment this-mac)`. What changes:

- `orca_run_create` runs `orca orchestration run-create --objective <t> --external --environment this-mac`,
  and every other orca call of every tool (reads, waits, terminals, worktrees, repos, search and the
  probes) carries `--environment this-mac`, so nothing goes to local Orca meanwhile. Create the Run
  first: in this mode `worker-start` makes none.
- Repo and worktree paths go as `path:<abs>` selectors, which Orca resolves on the paired host. With an
  environment on another machine, pass paths as they are on that host; the `ORCA_MCP_ROOTS` check
  still runs here, on the local path.
- An external coordinator has no workspace of its own, so Orca refuses `--worktree new-top-level`
  for it. `orca_worker_start` therefore creates the worktree first
  (`orca worktree create ... --environment this-mac`, with the owner tag) and starts the worker
  into it with `--worktree id:<id>`.
- After a restart keep the same `ORCA_MCP_ENVIRONMENT`; the Run is still bound to that paired
  device (`orca orchestration run-current --environment this-mac` shows it).
- A terminal that runs `orca orchestration run-use` on the Run takes it over. A pending
  `orca_wait` or `orca_check` on it then returns state `fenced` (code `consumer_fenced`)
  instead of an error, and the Run is no longer waited on.
- Any process of your user that can read the saved environment acts as the same coordinator;
  keep it as private as the pairing itself.

The environment name goes only on argv. The child process gets no `ORCA_ENVIRONMENT`,
`ORCA_PAIRING_CODE` or `ORCA_MCP_ENVIRONMENT` from the parent, so no other saved environment is
used by accident. Without `ORCA_MCP_ENVIRONMENT`, or when that environment's Orca lacks the
capability, every call behaves exactly as before and `orca_status` says why. When the environment
cannot be reached (not running, misnamed), every tool fails closed with an error naming it and the
reason (code `environment_unavailable`); it is asked again after 30 s. Once a read succeeds the mode
holds for the server's lifetime, so a session never switches between the paired Orca and the local one.
The flag names live in one adapter (`src/capabilities.ts`).

## Embedding

The handlers are exported, so a host can wrap them or serve them itself:

```ts
import { buildTools, createOrcaMcpServer, type ToolResult } from "@krzysztofkobra/orca-mcp";

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

## Related

[BuildContext/orca-mcp](https://github.com/BuildContext/orca-mcp) is another
community MCP bridge for Orca, with Streamable HTTP, OAuth and a supervised
dispatch flow, for remote or shared coordinators. This one stays stdio-only and
focuses on worker status, server-side waits and the external coordinator mode.

## License

MIT
