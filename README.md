# live-sessions

A Claude Code plugin (a function-hooks mod) that lists the live Claude Code and Codex sessions on this Mac.

- `/sessions` shows or hides the pane. A status line under the prompt keeps the counts: `Claude 22 (3 working) · Codex 11 (1 working)`.
- The pane groups sessions by repository (its origin, `owner/repo`), then worktree or branch, then each session, labelled `claude` (orange) or `codex` (blue). An idle row is white.
- A session is listed where it has been working, not where it started. That is the worktree it used most among the last 40 folders its transcript or rollout records.
- The `1d 2d 3d 7d all` buttons, or `/sessions 2d | 12h | all`, list only the sessions active that recently. The choice is kept.
- `↑ ↓` on a repository, worktree or session puts it in your own order, which is kept. Use `reset order` or `/sessions reset` to go back to the automatic order.
- In Terminal.app, a press on a session's title does one of two things:
  - For a session running in a terminal tab, it brings that tab to the front.
  - For a background Claude session, it opens a new window with `claude attach`.
- `[ to bg ]`, pressed twice, moves an idle Claude session into the background in its own tab. The mod hangs the session up, waits until it exits, then runs `claude --bg --resume <id>` and `claude attach`. The resumed session keeps the permission mode its transcript last recorded. After that, closing the tab leaves the session running.
  - Before anything is touched, the mod checks that the session is still the same idle Claude process. It must also be in front of its terminal (not suspended with Ctrl+Z), started directly by a shell (so the shell takes the typed resume), and running in a Terminal.app tab, with a permission mode the mod knows. Otherwise it is not moved, and a toast says why.
  - Limits: only Terminal.app, not tmux, iTerm or VS Code. Only the permission mode carries over, not `--model` or `--add-dir`. A background task the session itself started ends when it is hung up.

## Workspaces

A workspace is a project with your own name. It has a folder, an environment, and one tmux session with Claude and Codex in it.

- In the pane, `+ workspace` opens a form: a name, a folder, the environment (a list of the ones on this Mac) and, optionally, a new branch. `+ ws` on any branch or folder row opens it with that folder filled in.
- `/workspace new <folder> <env> <name> [--branch <branch>]` does the same from the prompt, for example `/workspace new ~/code/app work Practice RBAC`. `--branch=<branch>` and `-b <branch>` work too.
- A folder is an absolute path or starts with `~/`, in the form and the command alike.
- With a branch, the workspace gets that branch's own worktree beside the repository's main checkout, `<checkout>-worktrees/<branch>` (each `/` a `-`), even when the folder is itself a worktree or a submodule.
  - A new branch starts from the commit of the folder you chose. For `+ ws` on a branch's row, that is that branch.
  - A branch already there is checked out, and one only on a remote is checked out tracking it.
  - A worktree folder already there is refused, as is a folder whose main checkout git cannot find (a linked worktree of a repository with a separate git dir). The worktree is made by a script that `tests/host-check.mjs` runs for real on throwaway repositories.
- Create is taken once: a second press, or Enter, while one is being made, does not make another.
- What the form or the command makes: it saves the workspace, then opens a Terminal window on tmux session `ws-<id>` (`<id>` is the name in lowercase with dashes, e.g. `ws-practice-rbac`), with a `claude` window and a `codex` window in that folder.
- `<env>` is required, and picks the accounts the agents start under:
  - `default` uses `~/.claude` and `~/.codex`.
  - `work` uses `~/.claude-work` and `~/.codex-work`, through `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  An environment is offered only when both its Claude and Codex profiles exist, and a misspelt one is an error, never another account.
- Each agent starts with Claude Code's session variables and any inherited `CLAUDE_CONFIG_DIR` or `CODEX_HOME` cleared, so its transcript is kept and it runs on its own environment's account. When an agent exits, its window leaves a shell.
- Closing the window only detaches, and both agents keep running. `/workspace open <name>`, or `[open]` in the pane, brings it back:
  - It focuses a Terminal tab already attached, or opens a new one.
  - From inside tmux, it switches that terminal to the workspace.
  - In another terminal app, it gives the command to run.
  It refuses a folder that is gone, and a running `ws-<id>` session that was not started for this workspace. A new workspace never reuses the name of a session already running.
- The pane lists workspaces first, each with its agents (whatever runs in its tmux session) and a running or stopped state. Pressing an agent selects its tmux window.
- `⊕` on any session assigns it to a workspace (or to none). A running session cannot move into tmux, but an assigned one is listed under the workspace, tagged `assigned`. Assignment is by the session's lasting id: its Claude session id, or its Codex thread id. A session running in a workspace's own tmux session is listed there, whatever it is assigned to.
- `/workspace rm <name>` forgets a workspace. Its tmux session keeps running until `tmux kill-session -t ws-<id>`.
- The list is kept in `~/Library/Application Support/live-sessions/workspaces.json`, which every profile's sessions read. If that file can't be read, it is reported and never overwritten. Workspaces need tmux.

## Where it reads from

Collecting is read-only. Nothing in Claude's or Codex's own files is written. The only writes are the mod's own shared snapshot and its kept settings. The only actions that act on a session are the ones you press: bringing a tab to the front, attaching, and `[ to bg ]`, which ends and relaunches the session you chose.

| What | From |
| --- | --- |
| Claude sessions | `~/.claude*/sessions/<pid>.json`, checked against `ps` start times |
| Codex sessions | `codex` processes on a terminal (`pgrep`, `ps`). Of each process's environment, only `CODEX_HOME` and `PWD` leave the shell pipeline. Each terminal's thread comes from `<CODEX_HOME>/state_N.sqlite`, opened read-only. |
| Where a session works | The last 40 `"cwd"` values in its transcript or rollout. Only those strings leave the pipeline. |
| Repository, worktree, branch | `git rev-parse` and the remote URLs, with any user or token removed in the pipeline |
| Terminal background, focusing tabs | Terminal.app scripting (JXA) |

One snapshot, `~/Library/Caches/live-sessions/snapshot.json`, is shared by every session. Collection therefore runs about once every 30 s for the whole machine, or every 4 s while some pane is in view, however many sessions are open.

## Install

From this folder, which then stays the copy that sessions load:

```sh
claude plugin marketplace add /path/to/claude-live-sessions
claude plugin install live-sessions@claude-live-sessions --scope user
```

From GitHub, at a terminal session's prompt:

```
/plugin install live-sessions --marketplace d3r3nic/claude-live-sessions
```

To change it, edit this folder, then run `/reload-plugins` in a session.

## Checks

```sh
claude plugin validate .
claude plugin test .                                         # 74 tests
npx -p typescript@5.6.3 tsc -p .                             # after one load, which lays down .claude-plugin/types
node --experimental-strip-types tests/host-check.mjs [2d] [--slow]   # on this Mac: SQL, pipelines, a full collection, the move script on throwaway processes, workspaces on a private tmux server, the worktree script on throwaway repositories
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-terminal.mjs    # a Terminal window: move a throwaway session to the background
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-workspace.mjs   # a Terminal window: open a throwaway workspace, close it, agents keep running
```
