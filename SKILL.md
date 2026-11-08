---
name: orca-mcp
description: >-
  Drive coding agents running in Orca (stablyai/orca) through the orca-mcp tools:
  start workers in their own worktrees, watch their state, wait for them to
  finish, answer them and clean up. Use when the user wants work handed to
  Claude Code, Codex or another agent inside Orca, wants to know what those
  agents are doing, or asks to be told when they finish. Not for work you can
  do yourself or with your own subagents.
---

# Orca workers via orca-mcp

Every tool result starts with `<state>: <summary>` and carries the same facts as
structured content. Read the state, not the prose: `working`, `waiting`,
`blocked`, `done`, `failed`, `idle`, `ok`, `error`.

## Pick the path

- **Plain worktree** (`orca_worktree_create`): one agent, one task, nothing to
  coordinate. Works on every Orca, orchestration on or off. Track it by its
  terminal handle.
- **Orchestration** (`orca_worker_start`, optionally `orca_run_create` and
  `orca_task_create`): several workers, task dependencies, workers that ask
  questions or report `worker_done`. Needs Orca orchestration
  (`orca_status` says `orchestration on`). Without it `orca_worker_start` falls
  back to a plain worktree by itself.
- `orca_run_create` needs a coordinator identity. When `orca_status` says
  `external coordinator supported`, the server registers one for you. Otherwise
  skip it: `orca_worker_start` with a `spec` creates its own Run.

## Coordinator loop

1. `orca_status` once: is Orca running, is orchestration on.
2. Start every independent worker (`orca_worker_start` or
   `orca_worktree_create`). Each spec is self-contained: target, change,
   constraints, what it may edit, the evidence that proves it is done.
3. Loop on `orca_wait` (no arguments waits on every worker you started; pass
   `dispatch`, `terminal`, `worktree` or `run` to narrow it). It blocks
   server-side and returns one event:
   - `done` / `failed`: read the result (`orca_worker_read` or
     `orca_terminal_read`), check the evidence, report it.
   - `waiting` / `blocked`: the agent needs a human. Read its screen
     (`orca_terminal_read` with `screen: true`), answer with `orca_send` when
     the answer follows from the task, otherwise ask the user.
   - `working`: the timeout passed, nothing happened. Call `orca_wait` again.
   - `idle`: nothing left to wait on. Every worker already reported.
4. `orca_agent_status` any time for the whole picture in one call: per worker
   state, since when, current tool, what it waits on, last message, dispatch and
   task ids.
5. When the work is merged or abandoned, `orca_worker_stop` the agent and, only
   if the user agrees, `orca_worktree_rm` the worktree.

## Rules

- Never poll `orca_worktrees` or `orca_terminal_read` in a loop to see if a
  worker finished: `orca_wait` does that server-side and returns the moment it
  changes.
- Prefer `orca_send` over typing into a terminal; it reaches orchestration
  workers in any state.
- `orca_check` without `peek` takes the Run's mail; use `orca_wait`, which never
  does.
- Do not start a worker again because a start result looked odd. Look first
  with `orca_agent_status`: workers are tagged in Orca and found again even
  after this server restarts.
- Keep parallel workers few (three is a sane default) unless the user asks
  for more.
- Paths must lie inside the allowed roots (`ORCA_MCP_ROOTS`, default `~/dev`).
