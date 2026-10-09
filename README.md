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

A workspace is a project with your own name: a repository, an environment, and Claude and Codex side by side in one tmux session, ready to peer code. Its name is only your label; it never names a branch or a worktree.

- In the pane, `+ workspace` opens a form:
  - **name**: anything.
  - **project**: type to search the git repositories on this Mac (their main checkouts, up to five folders down from your home folder, skipping Library, hidden folders and `*-worktrees`), those worked in lately first, and pick one; or type a folder (absolute, or starting with `~/`).
  - **environment**: one of the environments on this Mac (below).
  - **what it is for** (optional): a sentence or two.
  `+ ws` on any branch or folder row opens the form with that folder as the project.
- `/workspace new <folder> <env> <name> [--for <what it is for>]` does the same from the prompt; every word after `--for` is the purpose.
- Create opens a Terminal window on tmux session `ws-<id>` (the window runs `/bin/sh <file>`, the file in `~/Library/Application Support/live-sessions/open/` holding the command line, so any login shell works) (`<id>` is the name in lowercase with dashes), with one window: Claude on the left and Codex on the right, both in the project's folder. Each may also work in `<checkout>-worktrees/`, beside the repository's main checkout (made if it is not there), where branches' worktrees go. Create is taken once: a second press, or Enter, while one is being made, does not make another.
- With a purpose (it needs a git repository), each agent starts with a first prompt, taken once (a restart never sends it again; `/workspace rm` deletes one never taken):
  - Claude gets peer coding ready under the peer-coding rules (the peer-coding skill): sets the repository up for it if it is not, starts a branch named for the purpose in its own worktree, makes its alignment move and ends its turn with the rules' cue line.
  - Codex is told it is the peer and that Claude's hand-off will come; it answers that it is ready.
  - The relay is on (below), so Claude's hand-off reaches Codex without copy and paste.
- `<env>` is required, and picks the accounts the agents start under:
  - `default` uses `~/.claude` and `~/.codex`.
  - `work` uses `~/.claude-work` and `~/.codex-work`, through `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  An environment is offered only when both its Claude and Codex profiles exist, and a misspelt one is an error, never another account.
- Each agent starts with Claude Code's session variables and any inherited `CLAUDE_CONFIG_DIR` or `CODEX_HOME` cleared, so its transcript is kept and it runs on its own environment's account. Codex starts without its update offer (whose default answer, on Enter, installs a new version) and always in the `workspace-write` sandbox, whatever your Codex config says, so it can write in the project and its worktrees folder: the sandbox Codex itself uses for a trusted project, and more than its read-only default for a folder it does not trust (where it would refuse the worktrees folder and exit). Its approvals stay as you set them. When an agent exits, its pane leaves a shell.
- Closing the window only detaches, and both agents keep running. `/workspace open <name>`, or `[open]` in the pane, brings it back:
  - It focuses a Terminal tab already attached, or opens a new one.
  - From inside tmux, it switches that terminal to the workspace.
  - In another terminal app, it gives the command to run.
  It refuses a folder that is gone, and a running `ws-<id>` session that was not started for this workspace. A new workspace never reuses the name of a session already running.
- The pane lists workspaces first, each with its agents (whatever runs in its tmux session) and a running or stopped state. Pressing an agent brings its pane up.
- `⊕` on any session assigns it to a workspace (or to none). A running session cannot move into tmux, but an assigned one is listed under the workspace, tagged `assigned`. Assignment is by the session's lasting id: its Claude session id, or its Codex thread id. A session running in a workspace's own tmux session is listed there, whatever it is assigned to.
- `/workspace rm <name>` forgets a workspace. Its tmux session keeps running until `tmux kill-session -t ws-<id>`.
- The list is kept in `~/Library/Application Support/live-sessions/workspaces.json`, which every profile's sessions read. If that file can't be read, it is reported and never overwritten. Workspaces need tmux.

### The relay

The peer-coding rules end every turn with one cue line for the owner to pass on: `READY FOR CODEX · …`, `READY FOR CLAUDE · …`, `NEEDS USER · …` or `SCOPE CLOSED · …`. The relay passes it for you, between a workspace's own two agents.

- `relay auto | notify | off` on a workspace's row switches it (pressed round). Turned on, it counts only turns that end from then on. A workspace made with a purpose starts with it on (`auto`).
- `auto`: when an agent's turn ends with `READY FOR` the other, the relay types that exact line into the other agent's pane and presses Enter, as you would. It does so:
  - once, whichever session sees it first (each step is a folder made in `~/Library/Application Support/live-sessions/relayed/`);
  - only while one of that pane's foreground processes is the agent (`claude`, `codex`), never into a shell;
  - only once that agent has finished a turn of its own (its first prompt), so it is past any question it asks at its start, which Enter would answer; until then it tells you once;
  - only while that agent is not at work (Claude idle; Codex with no task under way);
  - only while that pane is not scrolled back (copy mode, where the keys would go to tmux): the hand-off then waits, the workspace's row says why, and it is passed once you leave copy mode (`q`);
  - only for a turn that ended in the last 7 days.
  A command that only changes a setting or shows output (`/model`, `/compact`, `!ls`) starts no turn; a skill or a prompt command (`/peer-coding …`) starts one like a prompt; Claude replying with a tool call is at work; an interrupt (Esc), an error that ends the reply, or an aborted Codex task ends a turn. If the pane goes into copy mode while the line is being typed, the line waits in the agent's input and a notification asks you to press Enter there. When a pass cannot be made (the pane runs a shell, is gone, or tmux cannot type), a notification says why and gives the line to paste.
- `NEEDS USER` and `SCOPE CLOSED` are yours: a macOS notification says so, in any mode, and the count of hand-offs starts again.
- After 10 hand-offs in a row it waits for you: a notification, and `continue` on the workspace's row.
- `notify`: nothing is typed; a notification gives you the line to paste.
- What it reads: for a workspace with the relay on, from each agent's own records (its Claude transcript or Codex rollout, the last 600 lines), only how its last turn stands: finished or under way, its id and time, and the last cue line of its final reply. Nothing else of what was said leaves that pipeline (`jq`, macOS's own).
- It runs in whichever Claude Code session collects (every 30 s, or 4 s while a pane is shown), so a hand-off reaches the other agent within about half a minute, as long as some Claude Code session with this plugin is open (the workspace's own Claude counts).
- The peer-coding rules (Archetype's playbook) say the relay stays with the owner: this is that, done by your own tool, which you switch on per workspace; it passes only the agents' own cue lines, unchanged.

## Where it reads from

Nothing in Claude's or Codex's own files is ever written. Collecting reads, and writes only the mod's own shared snapshot, with one exception: for a workspace whose relay you turned on, it also types each hand-off into the other agent's pane and records that in the workspaces file and the relay's own folder (The relay, above). Otherwise the only actions on a session are the ones you press: bringing a tab to the front, attaching, `[ to bg ]` (which ends and relaunches the session you chose), and opening a workspace.

| What | From |
| --- | --- |
| Claude sessions | `~/.claude*/sessions/<pid>.json`, checked against `ps` start times |
| Codex sessions | `codex` processes on a terminal (`pgrep`, `ps`). Of each process's environment, only `CODEX_HOME` and `PWD` leave the shell pipeline. Each terminal's thread comes from `<CODEX_HOME>/state_N.sqlite`, opened read-only. |
| Where a session works | The last 40 `"cwd"` values in its transcript or rollout. Only those strings leave the pipeline. |
| Repository, worktree, branch | `git rev-parse` and the remote URLs, with any user or token removed in the pipeline |
| Terminal background, focusing tabs | Terminal.app scripting (JXA) |
| Workspaces, their agents and panes | `~/Library/Application Support/live-sessions/workspaces.json`; `tmux list-panes` and `list-clients` |
| The relay (workspaces with it on) | each agent's last 600 transcript or rollout lines, through `jq`: only how its last turn stands and its cue line; `ps -t` on its pane's terminal |
| Projects for the form (only while it is open) | `find` in your home folder, five folders down (skipping Library, hidden folders, `node_modules`, `*-worktrees`, and what is inside a `.git`): the paths of folders holding a `.git` folder |

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
claude plugin test .                                         # 83 tests
npx -p typescript@5.6.3 tsc -p .                             # after one load, which lays down .claude-plugin/types
node --experimental-strip-types tests/host-check.mjs [2d] [--slow]   # on this Mac: SQL, pipelines, a full collection, the move script on throwaway processes, workspaces and the relay on a private tmux server (reading no tmux.conf), the checkout script on throwaway repositories
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-terminal.mjs    # a Terminal window: move a throwaway session to the background
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-workspace.mjs   # a Terminal window: open a throwaway workspace, close it, agents keep running
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-relay.mjs       # the real Claude and Codex on a private tmux server: first prompts, turns read, lines typed and taken (a few short turns)
```
