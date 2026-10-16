# Changelog

What each version changed, newest first. Each links its pull request, which holds the details, the checks and the reviews. After updating, run `/reload-plugins` in your sessions.

## 0.36.0 — 2026-10-16
- **What Claude's use would cost, in dollars:** the usage panel and `/sessions usage` say what each account's Claude use in the window would cost at API list prices (`≈ $2,503`), and each project's part beside its share. It is a measure of how much work it was, not a bill (a plan is paid by the month). Codex has no price, as its plan's credits are not priced here. The figures were already counted for the shares; they are now shown.

## 0.35.0 — 2026-10-16
- **Agents need you less:** a workspace's agents are told to decide themselves what the request, the code, the project rules or a sound default settles, say their choice in one line and go on. When only you can decide, they ask (in a pair, with NEEDS USER) and add one line on what would let them skip such a question next time (a rule, a saved default, a check), which they put in place themselves when it is theirs to do. The relay's check-in asks the same. Claude has it on its next start or resume of its pane, Codex in the first prompt of a workspace made or an agent brought in from now on; a resumed Claude conversation takes it once it next compacts.

## 0.34.0 — 2026-10-15
- **Each workspace says what it is about:** coming back to a workspace after an hour, you can read the main problem it works on in one or two plain sentences, with no jargon: first in its details in the ops screen (a click on its tile), in a colour of its own, and on a pale yellow line under the bar at the top of its window. Its own Claude says it, from all it knows of the work, as you give it something (typed, or through Remote Control), before it starts; and at a turn's end while there is none yet, or after you typed to Codex. It is a side question to itself that its chat never shows: one short reply, on top of reading the conversation again, from the prompt cache while that holds it (after a long idle, in full, as the turn itself does). It is the problem you brought, not the step under way, and it is kept with the workspace. Background tasks' notices, scheduled prompts and other sessions' messages ask nothing. The line in the window is added only while your tmux bar is one line (tmux's default). A workspace running now gets one at its Claude's next turn; a workspace of Codex alone has none.

## 0.33.0 — 2026-10-14 ([#48](https://github.com/d3r3nic/claude-live-sessions/pull/48))
- **A workspace gone quiet is checked in with:** with the relay on, both agents idle, nothing to pass and nothing typed by you since the relay last typed into an agent, the relay looks at the last turn. One that ended with no cue line 5 minutes to 2 hours ago (an agent that stopped early, asked you something in passing, or said to paste a line by hand) gets one check-in typed into it, never over a reply you have started typing: go on with the plan if the next step is clear, else end with NEEDS USER or SCOPE CLOSED. If it stops so again, you are told once and nothing more is typed until you type. A turn you stopped (Esc), one you started, NEEDS USER and SCOPE CLOSED are left alone, however long they wait. You are also told when a hand-off has waited 10 minutes for the other agent to show at its prompt, when a check-in started nothing, and when an agent of the pair is no longer running in its pane.

## 0.32.3 — 2026-10-14 ([#46](https://github.com/d3r3nic/claude-live-sessions/pull/46))
- **Bringing in a Codex no longer holds up the new workspace for a minute:** Codex's shared server keeps a conversation about a minute after its terminal closes, and the workspace used to wait for that before it opened. It now opens at once, Claude starting its work, and the Codex pane waits for the server instead, saying so, then goes on in that conversation (still never in two places: it resumes only once no Codex holds it). Anything other than that server holding it is waited for before opening, as before.

## 0.32.2 — 2026-10-14 ([#47](https://github.com/d3r3nic/claude-live-sessions/pull/47))
- **Hand-offs to a resumed Codex no longer held back by what Codex wrote:** the relay waits until Codex is at its prompt, and took any "sign in" or "import" (any case, "important" too) on Codex's screen for one of its start-up questions. A resumed Codex shows its last message, so one that mentioned signing in held every hand-off back (seen: a workspace stalled for a day, Claude waiting for Codex and Codex at its prompt). It now looks for Codex's questions in Codex's own words, at the bottom of its screen only, and for Codex at work by its status line's shape anywhere on it (details, tips and queued follow-ups go under that line, far from the bottom). Seen on this Mac: two workspaces held back this way.

## 0.32.1 — 2026-10-14 ([#45](https://github.com/d3r3nic/claude-live-sessions/pull/45))
- **Agents' chats open in your light theme again:** a workspace's window, and a background session's, open in Terminal's default profile (Novel, light, on this Mac), no longer in the profile of the tab you open them from (since 0.28.1 a dark `/sessions` or ops tab made them dark). A workspace's tmux panes take that profile's text and background colours, so they look the same in any window, and Codex starting there colours its input line for them. A workspace running already takes them the next time it is opened, from /sessions or the ops screen (colours that cannot be read take away those set before, so its panes follow the window showing them); a Codex already running keeps its colours until it is stopped and started again (`■` then `►`). The ops screen still opens in the profile of the tab you open it from.

## 0.32.0 — 2026-10-14 ([#44](https://github.com/d3r3nic/claude-live-sessions/pull/44))
- **New workspace starts from your chats:** the form lists your running Claude and Codex chats first, from any folder (each with its folder), and you choose one of each to bring in, or none for an agent to start new. The folder fills in from the chat chosen, taken as it is, with no branch to choose: the agents settle the repository and branch as they get ready. Before, the form asked for a repository first and offered only the chats working in it, so a Codex working in the folder above the repository was never offered.
- **The chat you are in can be brought in too** (`(this session)`): in a new workspace, by `New workspace with it` on its own row, or by `Add Claude`. The workspace opens first, its Claude waiting while this session's process runs (its pid and start time); then this session closes between turns, and the conversation goes on there (the wait, the close by a process of the session's own and the resume run end to end with the real Claude in `tests/e2e-self.mjs`, a hook of that session standing in for the plugin's call). Before, the session whose pane made the workspace was never offered.
- **Briefed on what is next, purpose or not:** with a chat brought into a pair and nothing typed in `what it is for`, the agents are told to go on with the work under way in the chats that came, the one brought in getting a new peer up to speed, and the relay is on. A new Claude beside a Codex brought in goes on with Codex's branch, asking Codex where its work stands.
- **A Codex terminal no longer flips between offered and `not certain`:** a session not yet reloaded since 0.31 wrote the shared list of sessions without matching Codex terminals through their shared server, and sessions of 0.31 showed that list. The shared list's format is now 8, so a session never shows one an earlier version wrote. Run `/reload-plugins` in every session: until then each version collects for itself.
- **A purpose no longer needs the folder to be a git repository:** in a folder outside git, the agents work in the repository the purpose concerns, found as they get ready; a new Claude beside Codex's work asks Codex which one first.

## 0.31.0 — 2026-10-14 ([#43](https://github.com/d3r3nic/claude-live-sessions/pull/43))
- **Add the other agent to a workspace of one:** `Add Codex` (or `Add Claude`) in its actions, or `/workspace add <name> claude|codex [<id>]`: start it new, or bring in a running session of it from any folder, which goes on there in its own conversation. The workspace closes between turns and opens again with both; with a purpose, the agent that was there is told it no longer works alone, Claude gets peer coding ready and the relay is on. Before, a workspace made with one agent could not take the other, and `Assign to workspace` only lists a session under it.
- **Codex terminals started without options are certain again:** Codex 0.162 runs such a terminal's conversation in a shared background server (`codex app-server --managed-daemon`), so the terminal holds no conversation file and was never offered to bring in (`not certain`). The server holds the file open for it: such a terminal is now matched through what its server holds, when the server's terminals and conversations pair off in one way only (two working in one folder do not), and offered.
- **A Codex conversation is not resumed while a Codex holds it open:** it goes on in a workspace (brought in, added, or opened again) only once no Codex process holds its file open (the desktop app holds none, so it is not seen). The shared server lets one go about a minute after its terminal closes: it waits up to 90 s, saying so.
- **A workspace's Codex runs its conversation itself** (`--no-daemon`), never in the shared server, so which conversation it runs stays certain. A Codex already running keeps how it started until the workspace is stopped and started again.

## 0.30.2 — 2026-10-13 ([#42](https://github.com/d3r3nic/claude-live-sessions/pull/42))
- **Codex's input line and your messages no longer beige on a dark window:** Codex asks the terminal for its background once, at its start, and colours them from it; tmux answered with a colour left from an earlier light window. A workspace's tmux window now takes the background of the tab it is opened from, set before its agents start. A Codex already running keeps its colours until the workspace is stopped and started again (`■` then `►` on the Ops screen).

## 0.30.1 — 2026-10-13 ([#41](https://github.com/d3r3nic/claude-live-sessions/pull/41))
- **Ops tiles with room:** two cells inside each side, three between tiles side by side, a blank line between rows of tiles, a cell's margin at each end of a row.

## 0.30.0 — 2026-10-13 ([#40](https://github.com/d3r3nic/claude-live-sessions/pull/40))
- **Ops screen, FOCUS and HISTORY:** running workspaces under `FOCUS`; stopped ones under `HISTORY`, a line kept at the bottom of the screen, folded until a click on it or `h` opens it (kept), where each is started again. FOCUS comes first: an open HISTORY takes only the rows below it, and says what of it does not fit.
- **/sessions on a dark tab:** Claude's and Codex's names in lighter colors (`#e8875f`, `#6aa5ff`), readable on black; on a light tab as before. (The pane's frame and the theme's own accent colors are Claude Code's theme: on a dark terminal choose a dark one in `/theme`.)
- **Ops tiles drawn with square corners** (`┌┐└┘`): fonts such as Andale Mono (the Homebrew profile's) have no rounded corners, which another font then drew out of line, the top and bottom borders seeming moved up. Play is `►`, HISTORY's arrows `▼ ▲`, for the same reason.
- **Ops tiles:** their buttons on the bottom border at the right: `[>_]` brings up the terminal, `[■]` in red stops (pressed twice), `[►]` starts a stopped one. No `[»]` (a click on the tile shows its details) and no relay line (`⇄ auto → Claude 1m`; the details still show the relay). The details say `[>_ open window]`, `[■ stop]`, `[► start]`.

## 0.29.1 — 2026-10-13 ([#39](https://github.com/d3r3nic/claude-live-sessions/pull/39))
- **After a restart, hand-offs pass again without you:** a resumed agent takes the next hand-off once its pane shows it at its prompt, without first finishing a turn of its own. Claude: idle 3 s by its own status, not at its resume question (from a summary or in full), which you answer; Codex: its prompt's footer showing, none of its start-up questions (trust, a model switch, an import, sign-in), not at work. Before, every reopened workspace held its first hand-off each way until you typed to the other agent.

## 0.29.0 — 2026-10-13 ([#38](https://github.com/d3r3nic/claude-live-sessions/pull/38))
- **Ops screen:** while one agent of a workspace works, the other, idle, says nothing (no `idle`); both working both say `working`. The workspace's name is yellow (amber) while it works, as its border.
- **Workspace bar:** `HIDE WINDOW` at its right end (it said `Hide window · agents keep running` after the name); the name alone at its left. Your tmux.conf's right-end commands (tmux-continuum's save) are carried after it and keep running; the rest of that right end (pane title, clock) is not shown there.

## 0.28.2 — 2026-10-13 ([#37](https://github.com/d3r3nic/claude-live-sessions/pull/37))
- **/sessions:** an idle session's row is no longer highlighted white; its state and mark say what it does, as for every other row.

## 0.28.1 — 2026-10-13 ([#36](https://github.com/d3r3nic/claude-live-sessions/pull/36))
- **Windows the plugin opens take the colours of the tab you open them from** (its Terminal profile): workspace windows, background sessions' windows and the Ops screen, and the windows the Ops screen opens. Before, they took Terminal's default profile, which on a Mac whose default is a light one put light windows (and a light strip at the Ops screen's right edge) beside dark tabs. An Ops screen already open keeps its window: close it and press `Ops screen` once.

## 0.28.0 — 2026-10-13 ([#35](https://github.com/d3r3nic/claude-live-sessions/pull/35))
- **Close a workspace for now, open it again later:** `/workspace close <name>`, `Close` in the pane or `■` on its Ops tile (each pressed twice) ends its agents between turns and keeps their conversations; `Open` starts it again, each going on with its own. Nothing is closed while an agent works, waits on you or has background work running.
- **After a restart or a crash:** a workspace's tmux session that a session restore (tmux-resurrect) brought back as empty shells counts as stopped, and `Open` replaces it with the workspace, resuming its conversations. The Ops screen's `📁` now starts a stopped workspace too, through a Claude session running this plugin in a Terminal tab.
- **tmux-continuum saves again while workspace windows are open:** a workspace's bar no longer replaces the bar's right end (where tmux.conf runs the save from); `Hide window` moved next to the workspace's name.

## 0.27.0 — 2026-10-12 ([#34](https://github.com/d3r3nic/claude-live-sessions/pull/34))
- **Every workspace agent runs bypassed**, new or resumed: Claude with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox` (no `--add-dir` needed). A conversation brought in, or resumed when a workspace opens again, no longer keeps the mode it ran in; the permission flags earlier versions kept with it are let go. Sessions outside workspaces, and `To background`, are as before.

## 0.26.0 — 2026-10-12 ([#33](https://github.com/d3r3nic/claude-live-sessions/pull/33))
- **New workspace for work already under way:** the form's **repository** field takes any path in a repository, a branch's worktree or a file in one, typed or pasted (as an editor names a file, too). Its repository becomes the project and its branch is chosen to go on with. Searching finds the branches' worktrees by their folder's name, and `New workspace here` on a branch's row goes on with that branch. A new branch for the purpose (the default) is the clean start.

## 0.25.0 — 2026-10-12 ([#32](https://github.com/d3r3nic/claude-live-sessions/pull/32))
- **Background work counts as work.** A Claude session whose turn is over while a command or monitor it started in the background still runs is `background` (◐), never idle or `done`, in /sessions and the Ops screen, in the event log as `BG WORK`, and counted in the header and status line. Each session's background commands, monitors and agents are listed under it (`↳ monitor  Wait for CI on PR 826 · 4m`) until they end, expire or are stopped.
- **Ops screen:** an agent waiting on you at a permission prompt or dialog shows `◆ waiting` in red, never idle or done.
- **Ops screen, compact view** (the default; `COMPACT` in the toolbar, key `v`, kept): each workspace a small tile, as many a row as the window holds, coloured and marked by what it does; `[📁]` opens its window, `[»]` or a click on it shows all its details over the screen (esc closes). `COMPACT` off is the detailed view as before.

## 0.24.0 — 2026-10-12 ([#31](https://github.com/d3r3nic/claude-live-sessions/pull/31))
- **`ABC-XYZ`: names kept off the screens**, for a screen others see. List them in `~/Library/Application Support/live-sessions/names.json` (`{"names": ["Acme Corp"]}`). While `ABC-XYZ` is lit, in /sessions or the Ops screen, each shows as dots (`•••• Practice`, `~/dev/••••-2025/app`) in any letter case and spelling (`acme-corp`, `AcmeCorp`), in the pane, its toasts, the Ops screen and the relay's notifications. One press turns it on or off on every screen.
- **Ops screen toolbar:** `GRID` and `EVENTS` show or hide the grid and the event log (keys `g` and `e`, names `n`); the choice is kept.

## 0.23.0 — 2026-10-11 ([#30](https://github.com/d3r3nic/claude-live-sessions/pull/30))
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
