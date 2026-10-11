# Changelog

What each version changed, newest first. Each links its pull request, which holds the details, the checks and the reviews. After updating, run `/reload-plugins` in your sessions.

## 0.23.0 — 2026-10-11
- **Ops screen:**
  - a workspace where any agent works says `● WORKING` in front of its name, in amber;
  - an idle workspace is drawn lighter, with `done 5m ago`;
  - each agent line shows only its state and its `context`, coloured by how full it is (amber from two thirds of where it should compact, red past it); no window size, no conversation name;
  - the header says `updated 4s ago` as plain text;
  - only a workspace's `OPEN` button, down its left side, opens it; its agent lines open nothing.
- **Agent windows** use a font a little smaller than your tab's (80% of it).

## 0.22.2 — 2026-10-11 ([#29](https://github.com/d3r3nic/claude-live-sessions/pull/29))
- Agent windows (a workspace's, from /sessions or the Ops screen, and a background session's) open at 60% of the screen across and down, centred, in your tab's own font (twice the half size of 0.22.1).

## 0.22.1 — 2026-10-11 ([#27](https://github.com/d3r3nic/claude-live-sessions/pull/27))
- Agent windows open maximized at half your tab's font: a workspace's window (from /sessions or the Ops screen) and a background session's window. A workspace window no longer keeps the size and font it had when last hidden; it opens on the screen it was mostly on.
- The Ops screen uses your tab's own font again, as before 0.21.

## 0.22.0 — 2026-10-11 ([#26](https://github.com/d3r3nic/claude-live-sessions/pull/26))
- **One window per thing:** a background session's row, or the `Ops screen` button, brings the window already showing it to the front instead of opening another. Workspace windows already did this.
- **The Ops screen, cleaner:**
  - the account appears once, in the header;
  - no window open/hidden labels;
  - one line per agent: working/idle, context size, title;
  - the relay line reads `6 of 10 hand-offs in a row`;
  - `OPERATOR INPUT REQUIRED` only while a cue really waits for you.
- **The Ops screen keeps itself current:** it restarts in place when the plugin's code changes, once the new code loads. If the new code does not load, it keeps running and says why.
- **Context after a compaction:** a context compacted since its last request reads `compacted`, not the old size.

## 0.21.0 — 2026-10-11 ([#25](https://github.com/d3r3nic/claude-live-sessions/pull/25))
- **Compaction is a checkpoint, never a stop:** Claude compacts at its hand-off from 300k tokens (200k, 300k, 400k, 500k or off).
- **Every compaction is watched for drift:** a drift check follows Claude's next hand-off, and the workspace box says when it compacted and whether a check has looked.
- **Windows:** the workspace's name moves to the top of its window, and `peers*` is gone; windows the plugin opens are larger.

## 0.20.0 — 2026-10-11 ([#24](https://github.com/d3r3nic/claude-live-sessions/pull/24))
- **Usage view:** each session's context size; each account's 5-hour and 7-day limits for Claude and Codex; usage by project (`/sessions usage`).

## 0.19.0 — 2026-10-11 ([#23](https://github.com/d3r3nic/claude-live-sessions/pull/23))
- **Leaner workspaces:** Claude compacts at its hand-off from 200k tokens, and both agents are told to work lean.

## 0.18.0 — 2026-10-10 ([#22](https://github.com/d3r3nic/claude-live-sessions/pull/22))
- **One account at a time:** each session sees its own account's sessions and workspaces; `all accounts` shows every account.

## 0.17.0 — 2026-10-10 ([#21](https://github.com/d3r3nic/claude-live-sessions/pull/21))
- **Pane:** each workspace in a box of its own.

## 0.16.0 — 2026-10-10 ([#20](https://github.com/d3r3nic/claude-live-sessions/pull/20))
- Claude compacted just before its prompt cache expired. This was removed in 0.19.

## 0.15.0 — 2026-10-10 ([#19](https://github.com/d3r3nic/claude-live-sessions/pull/19))
- **Codex compacts itself:** the relay types only hand-offs into it.

## 0.14.0 — 2026-10-10 ([#18](https://github.com/d3r3nic/claude-live-sessions/pull/18))
- **Workspaces can go on with a branch already under way.**

## 0.13.0 — 2026-10-10 ([#17](https://github.com/d3r3nic/claude-live-sessions/pull/17))
- **Workspaces of one agent:** Claude only or Codex only.

## 0.12.0 — 2026-10-10 ([#16](https://github.com/d3r3nic/claude-live-sessions/pull/16))
- **Drift check:** at milestones, the agents' work is held against the workspace's purpose.

## 0.11.0 — 2026-10-10 ([#15](https://github.com/d3r3nic/claude-live-sessions/pull/15))
- **Ops screen:** a full-screen console whose rows open what they are about.

## 0.10.0 — 2026-10-10 ([#14](https://github.com/d3r3nic/claude-live-sessions/pull/14))
- **Context guard:** an agent compacts at a hand-off once its context is full enough.

## 0.9.0 — 2026-10-10 ([#12](https://github.com/d3r3nic/claude-live-sessions/pull/12))
- **Bring running sessions in:** running Claude and Codex sessions can be brought into a workspace, and each pane keeps its conversation.

## 0.8.2 — 2026-10-10 ([#13](https://github.com/d3r3nic/claude-live-sessions/pull/13))
- **Relay:** a `/compact` is not counted as a turn, nor as the owner's typing.

## 0.8.1 — 2026-10-10 ([#11](https://github.com/d3r3nic/claude-live-sessions/pull/11))
- **Relay:** your prompt starts the hand-off count again, and the cap holds only a cue it would pass.

## 0.8.0 — 2026-10-10 ([#10](https://github.com/d3r3nic/claude-live-sessions/pull/10))
- **Workspace windows:** they open where they were, or large in your own font.

## 0.7.2 — 2026-10-10 ([#9](https://github.com/d3r3nic/claude-live-sessions/pull/9))
- **Hide:** repairs from the review.

## 0.7.1 — 2026-10-10 ([#8](https://github.com/d3r3nic/claude-live-sessions/pull/8))
- **Hide:** nothing it prints shows in a pane, and the bar names the workspace.

## 0.7.0 — 2026-10-10 ([#7](https://github.com/d3r3nic/claude-live-sessions/pull/7))
- **Hide window:** from the window's own bar or from the pane; the agents keep running.

## 0.6.1 — 2026-10-10 ([#6](https://github.com/d3r3nic/claude-live-sessions/pull/6))
- **Workspaces:** each side can be used on its own, with the mouse on in the session and the sides named.

## 0.6.0 — 2026-10-10 ([#5](https://github.com/d3r3nic/claude-live-sessions/pull/5))
- **Pane:** one `[ more ]` per row; its actions show as worded buttons with keys.

## 0.5.0 — 2026-10-09 ([#4](https://github.com/d3r3nic/claude-live-sessions/pull/4))
- **Peer workspaces:**
  - a workspace has a project and a purpose;
  - Claude gets peer coding ready;
  - the relay passes hand-offs between the agents.

## 0.4.0 — 2026-10-09 ([#3](https://github.com/d3r3nic/claude-live-sessions/pull/3))
- **Workspaces from the pane:** a form; a workspace from any branch; assigning sessions to it.

## 0.3.0 — 2026-10-09 ([#2](https://github.com/d3r3nic/claude-live-sessions/pull/2))
- **Workspaces:** named projects with Claude and Codex in one tmux session.

## 0.2.0 — 2026-10-09 ([#1](https://github.com/d3r3nic/claude-live-sessions/pull/1))
- **The live-sessions plugin:**
  - the `/sessions` pane of live Claude Code and Codex sessions;
  - a status line;
  - opening a session's tab;
  - moving a session to the background.
