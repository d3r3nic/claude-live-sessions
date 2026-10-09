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
claude plugin test .                                         # 51 tests
npx -p typescript@5.6.3 tsc -p .                             # after one load, which lays down .claude-plugin/types
node --experimental-strip-types tests/host-check.mjs [2d] [--slow]   # on this Mac: SQL, pipelines, a full collection, the move script on throwaway processes
node --experimental-strip-types tests/e2e-terminal.mjs       # opens a Terminal window, moves a throwaway session to the background, cleans up
```
