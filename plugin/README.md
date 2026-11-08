# Agent Status Bridge

Companion Orca plugin for [orca-mcp](../README.md). Its worker (`src/worker.ts`) listens to
Orca's `agent.status.changed`, `workspace.created` and `workspace.removed` events and writes each
one as an NDJSON line `{"v":1,"event":"<name>","payload":<Orca's payload>}` to every orca-mcp
server of the same user. Each server listens on `<tmpdir>/orca-mcp-<uid>/<pid>.sock`; the worker
writes only into that dir when it is a real directory owned by the user with no group or other
access. With the plugin running, `orca_wait` wakes on the event instead of polling `orca worktree
ps` every 5 s, and `orca_agent_status` reports `via: "push"`. Without it orca-mcp polls as before.

It asks for `agent:read` and `workspace:read`, and as a `trusted-worker` it runs as its own Node
process with your user's access, so Orca asks you to approve it before it loads.

The socket dir comes from `os.tmpdir()` (`TMPDIR`) on both sides. Orca passes `TMPDIR` to plugin
workers; an MCP client that starts orca-mcp with a different `TMPDIR` puts its socket where the
plugin does not look, and that server keeps polling.

Windows: off on both sides. Named pipes live in one namespace shared by every user of the
machine, so another user could create a matching pipe first and receive the events; the worker
writes nothing there and orca-mcp polls.

## Develop

```sh
orca plugin validate .
orca plugin test .         # runs src/worker.test.ts with orca/testing, outside the app
orca plugin dev watch .    # loads this folder into Orca (asks for approval); Ctrl-C unloads it
```
