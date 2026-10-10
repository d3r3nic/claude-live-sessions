# live-sessions

A Claude Code plugin (a function-hooks mod) that lists the live Claude Code and Codex sessions on this Mac.

- `/sessions` shows or hides the pane. A status line under the prompt keeps the counts: `Claude 22 (3 working) · Codex 11 (1 working)`.
- **One account at a time.** A session's pane, its status line and the ops screen it opens show its own account: the Claude sessions and Codex conversations of that account's profiles (`claude` and `codex` for the default account, `claude-<name>` and `codex-<name>` for another) and that account's workspaces. `account: default` (or the account's name), beside the activity buttons, switches to `all accounts` and back; the choice is kept for that account's next sessions. A session under a profile the plugin cannot name sees every account. A new workspace starts in the session's own account. Each account sees its own only where this plugin is installed for it (`claude plugin install` under that account's `CLAUDE_CONFIG_DIR`).
- The pane groups sessions by repository (its origin, `owner/repo`), then worktree or branch, then each session, labelled `claude` (orange) or `codex` (blue). An idle row is white.
- A session is listed where it has been working, not where it started. That is the worktree it used most among the last 40 folders its transcript or rollout records.
- The `1d 2d 3d 7d all` buttons, or `/sessions 2d | 12h | all`, list only the sessions active that recently. The choice is kept.
- Each row (a repository, worktree, session or workspace) has one `[ more ]` button. Pressed, the row's actions show under it as worded buttons, e.g. `[ Open (o) ]  [ To background ]  [ Assign to workspace (w) ]  [ Move up (u) ]  [ Move down (d) ]  [ Close (x) ]`. One row's actions show at a time.
- A key in brackets presses its button once you give the pane the keys (`ctrl+x tab`); typing in the prompt never does. What moves a session, removes a workspace or switches its relay has no key: those take a click (`To background` and `Remove`, two).
- `Move up` and `Move down` put a row in your own order, which is kept. Use `reset order` or `/sessions reset` to go back to the automatic order.
- In Terminal.app, a press on a session's title does one of two things:
  - For a session running in a terminal tab, it brings that tab to the front.
  - For a background Claude session, it opens a new window with `claude attach`.
- `To background`, pressed twice, moves an idle Claude session into the background in its own tab. The mod hangs the session up, waits until it exits, then runs `claude --bg --resume <id>` and `claude attach`. The resumed session keeps the permission mode its transcript last recorded. After that, closing the tab leaves the session running.
  - Before anything is touched, the mod checks that the session is still the same idle Claude process. It must also be in front of its terminal (not suspended with Ctrl+Z), started directly by a shell (so the shell takes the typed resume), and running in a Terminal.app tab, with a permission mode the mod knows. Otherwise it is not moved, and a toast says why.
  - Limits: only Terminal.app, not tmux, iTerm or VS Code. Only the permission mode carries over, not `--model` or `--add-dir`. A background task the session itself started ends when it is hung up.

## Workspaces

A workspace is a project with your own name: a repository, an environment, and Claude and Codex side by side in one tmux session, ready to peer code (or one of them alone). Its name is only your label; it never names a branch or a worktree.

- In the pane, `+ New workspace` (key `n`) opens a form; with the pane holding the keys, what you type next goes into its name:
  - **name**: anything.
  - **project**: type to search the git repositories on this Mac (their main checkouts, up to five folders down from your home folder, skipping Library, hidden folders and `*-worktrees`), those worked in lately first, and pick one; or type a folder (absolute, or starting with `~/`).
  - **branch** (shown once a project is picked, when its repository has worktrees with a branch checked out): start a new one for the purpose (the default), or go on with one of those branches. Going on with one makes its worktree the workspace's folder, and the first prompts say to go on with that branch there and start no other (for work already under way, so the agents never start it over). The row then says `on <branch>`.
  - **agents**: Claude and Codex (the default), Claude only, or Codex only. A workspace of one agent has that agent alone in its one pane: no peer coding and no relay, so none of what goes by hand-offs (the relay, Claude compacts at, the drift check). Its row says which agent it runs.
  - **environment**: one of the environments on this Mac (below).
  - **what it is for** (optional): a sentence or two.
  - **bring in** (shown once a project is chosen): the Claude sessions and Codex terminals already running in that repository (any of its worktrees), at most one of each (of the chosen agent only, for a workspace of one; choosing one lets a session of the other go). Each one brought in closes where it runs and goes on in the workspace, in its own conversation (below).
  `New workspace here`, in a branch or folder row's actions, opens the form with that folder as the project. `New workspace with it`, in a running session's actions, opens it with that session's folder and environment, the session chosen to bring in.
- `/workspace new <folder> <env> <name> [--only claude|codex] [--go-on] [--for <what it is for>]` does the same from the prompt; `--only` makes a workspace of that one agent, `--go-on` has the agents go on with the branch checked out in `<folder>`, a branch's own worktree (read from git; a folder with no branch checked out, or in the repository's main checkout, is refused), and every word after `--for` is the purpose.
- Create opens a Terminal window on tmux session `ws-<id>` (the window runs `/bin/sh <file>`, the file in `~/Library/Application Support/live-sessions/open/` holding the command line, so any login shell works) (`<id>` is the name in lowercase with dashes), with one window: Claude on the left and Codex on the right (or the one agent chosen), in the project's folder. Each may also work in `<checkout>-worktrees/`, beside the repository's main checkout (made if it is not there), where branches' worktrees go. Create is taken once: a second press, or Enter, while one is being made, does not make another.
- With a purpose (it needs a git repository), each agent starts with a first prompt, taken once (a restart never sends it again; `/workspace rm` deletes one never taken):
  - Claude gets peer coding ready under the peer-coding rules (the peer-coding skill): sets the repository up for it if it is not, starts a branch named for the purpose in its own worktree (or goes on with the branch you chose), makes its alignment move and ends its turn with the rules' cue line.
  - Codex is told it is the peer and that Claude's hand-off will come; it answers that it is ready.
  - The relay is on (below), so Claude's hand-off reaches Codex without copy and paste.
  - A workspace of one agent: that agent gets ready for the purpose (going on with a branch or worktree the purpose names, else starting a branch named for it in its own worktree), says in a few lines where things stand and what it would do first, and waits for you. No relay is turned on.
- **Bringing running sessions in.** A Claude session in a terminal (not one in the background, nor the session you are in) or a Codex terminal, of the chosen repository and not already in a workspace, can be brought into a new one:
  - A Codex terminal is offered only when which conversation it runs is certain, since Codex records no link between a terminal and its conversation: it holds that conversation's file open (checked again, fresh, before it is closed); or it is the only Codex terminal under its account and no other conversation made in a terminal there was written since it started (checked again in Codex's own records before it is closed; a `/new` or `/resume` inside it would make one). Any other is shown (by its terminal alone, as which conversation it runs is a guess) with why it is not offered, never closed: close it yourself, and its conversation is then offered as `(closed)`. In practice this means one Codex terminal per account, since most terminals run through Codex's shared background service and hold no file: while another Codex terminal of the account is open (a workspace's own Codex too), none of them is offered, no `(closed)` conversation is, and a workspace's Codex conversation is not remembered (after a restart it starts new).
  - A Codex conversation made in a terminal and open in none (closed by you) is offered as `(closed)`, once every Codex terminal under that account is certain (else it may be the one an uncertain terminal runs) and it has not been written in the last minute: nothing is closed, it is resumed in the workspace.
  - Each is checked first, all before anything is closed: between turns (Codex by its whole conversation file), in front of its terminal, under the form's environment. Claude's permission mode is read from its own records (a mode this does not know stops it; none recorded resumes in your default mode); Codex's sandbox, approvals and folder from its conversation's last settings. Other launch options (a model, extra folders) are not carried over.
  - Then, one at a time, each is checked again and closed where it runs, as closing its terminal would: that very process, with its job in front of that terminal, is hung up and waited for (20 s at most), and the terminal keeps its shell. One that began a turn meanwhile, or did not close, is left as it was: that agent starts new in the workspace, and you are told.
  - In the workspace, each resumes its own conversation: Claude with `claude --resume <id>` from the folder it started in, with its permission flags; Codex with `codex resume <id>` in its folder, its full access kept if it had it (anything else runs `workspace-write`, as a new workspace's Codex does, which its worktrees folder needs) and its approvals kept (`on-request` or `never`, what `codex resume` takes).
  - Claude may first ask how to resume a large conversation (from a summary or in full): answer it in its pane. The relay types into a brought-in agent only after it has finished a turn in the workspace, so it never answers such a question.
  - With a purpose, a brought-in agent's first prompt tells it the owner moved its conversation into the workspace and it keeps all it knows: Claude goes on with the work's peer-coding branch if it has one (or starts one; work not committed yet is the owner's call, asked with NEEDS USER) and tells Codex where the work stands; Codex waits for that hand-off and adds what its own work knows. An agent starting new is told the other was brought in.
- **A workspace remembers each pane's conversation:** an interactive Claude session, or a Codex terminal whose conversation is certain, under the workspace's environment. When the workspace is opened again after its tmux session ended (a restart), each agent goes on with its own. A conversation is kept by one workspace at most (the latest to see or bring it in). It is not opened while one of those conversations runs elsewhere: a Claude session with it (the pane checks again as it starts), a Codex terminal matched to it, or a Codex conversation written in the last minute. Not seen: one open in the Codex desktop app and idle, one switched to with `/resume` inside another Codex terminal and idle over a minute, or one a `codex exec resume` run drives with no terminal (as from an agent's shell tool). Each resumed agent counts as joined anew, so the relay types into it only after a turn from there.
- `<env>` is required, and picks the accounts the agents start under:
  - `default` uses `~/.claude` and `~/.codex`.
  - `work` uses `~/.claude-work` and `~/.codex-work`, through `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
  An environment is offered only when both its Claude and Codex profiles exist, and a misspelt one is an error, never another account.
- Each agent starts with Claude Code's session variables and any inherited `CLAUDE_CONFIG_DIR` or `CODEX_HOME` cleared, so its transcript is kept and it runs on its own environment's account. Codex starts without its update offer (whose default answer, on Enter, installs a new version) and always in the `workspace-write` sandbox, whatever your Codex config says, so it can write in the project and its worktrees folder: the sandbox Codex itself uses for a trusted project, and more than its read-only default for a folder it does not trust (where it would refuse the worktrees folder and exit). Its approvals stay as you set them. When an agent exits, its pane leaves a shell.
- Each side is used on its own: in a workspace's tmux session (that session alone; tmux.conf and other sessions are left as they are) the mouse is on. A click on a side gives it your keys; the wheel scrolls the side under it (back at the bottom, or `q`, it is live again). Each side's border names its agent, and the side that takes your keys says `your keys go here`. A workspace made before this gets the same, in each of its windows, when it is opened. With the mouse on, tmux also has its own uses for it in that session: a drag selects into tmux's copy buffer, a right-click opens tmux's pane menu, a middle-click pastes tmux's buffer.
- **Hiding a workspace's window** (its agents keep running, like a session moved to the background): click `Hide window · agents keep running` at the right of the window's bottom bar, or `Hide window` in the workspace's actions in the pane. It detaches the window from tmux, then closes it: only a window of that one tab, back at its shell, so nothing running is ever closed (a terminal tmux could not detach is left as it is). A workspace you switched to from inside your own tmux session goes back to that session instead. `Open` brings it back; a workspace opened again after its session ended (a restart) gets its Hide again. The click is tmux's (bound for the whole tmux server, over tmux's own binding for a click on a status bar, which every other click there keeps); if you bound that click to something of your own, it is left as it is and the bar only says that closing the window leaves the agents running.
- **Where its window opens:** where it was when last hidden (its place, size and font, kept in `~/Library/Application Support/live-sessions/windows/`), while at least a quarter of that still shows on a screen there is now; otherwise, and the first time, most of the screen in use (85% of what the menu bar and Dock leave, centred), in the font size of the window you opened it from. Only that window's tab takes the font; your Terminal profile is left as it is. Removing the workspace removes what was kept for it.
- Closing the window only detaches, and both agents keep running. `/workspace open <name>`, or `Open` on its row in the pane, brings it back:
  - It focuses a Terminal tab already attached, or opens a new one.
  - From inside tmux, it switches that terminal to the workspace.
  - In another terminal app, it gives the command to run.
  It refuses a folder that is gone, and a running `ws-<id>` session that was not started for this workspace. A new workspace never reuses the name of a session already running.
- The pane lists workspaces first, each in a box of its own a line apart, with its agents (whatever runs in its tmux session) and a running or stopped state. A box's border is marked while the workspace waits on you and dim otherwise: the relay holding a hand-off at its limit; a cue for you, a hand-off it could not pass or a pane left scrolled back, with nothing typed by you since; or a drift check not on track (never with the relay off). On a pane narrower than 60 columns there is no box, only the line between workspaces. Pressing an agent brings its pane up.
- `Assign to workspace`, in a session's actions, assigns it to a workspace (or to none). A running session cannot move into tmux, but an assigned one is listed under the workspace, tagged `assigned`. Assignment is by the session's lasting id: its Claude session id, or its Codex thread id. A session running in a workspace's own tmux session is listed there, whatever it is assigned to.
- `/workspace rm <name>`, or `Remove` (pressed twice) in its actions, forgets a workspace. Its tmux session keeps running until `tmux kill-session -t ws-<id>`.
- The list is kept in `~/Library/Application Support/live-sessions/workspaces.json`, which every profile's sessions read. If that file can't be read, it is reported and never overwritten. Workspaces need tmux.

### The relay

The peer-coding rules end every turn with one cue line for the owner to pass on: `READY FOR CODEX · …`, `READY FOR CLAUDE · …`, `NEEDS USER · …` or `SCOPE CLOSED · …`. The relay passes it for you, between a workspace's own two agents.

- `Relay: auto | notify | off` on a workspace's row switches it (pressed round). Turned on, it counts only turns that end from then on. A workspace made with a purpose starts with it on (`auto`).
- `auto`: when an agent's turn ends with `READY FOR` the other, the relay types that exact line into the other agent's pane and presses Enter, as you would. It does so:
  - once, whichever session sees it first (each step is a folder made in `~/Library/Application Support/live-sessions/relayed/`);
  - only while one of that pane's foreground processes is the agent (`claude`, `codex`), never into a shell;
  - only once that agent has finished a turn of its own (its first prompt), so it is past any question it asks at its start, which Enter would answer; until then it tells you once;
  - only while that agent is not at work (Claude idle; Codex with no task under way);
  - only while that pane is not scrolled back (copy mode, where the keys would go to tmux): the hand-off then waits, the workspace's row says why, and it is passed once you leave copy mode (`q`);
  - only for a turn that ended in the last 7 days.
  A command that only changes a setting or shows output (`/model`, `/compact`, `!ls`) starts no turn; a skill or a prompt command (`/peer-coding …`) starts one like a prompt; Claude replying with a tool call is at work; an interrupt (Esc), an error that ends the reply, or an aborted Codex task ends a turn. If the pane goes into copy mode while the line is being typed, the line waits in the agent's input and a notification asks you to press Enter there. When a pass cannot be made (the pane runs a shell, is gone, or tmux cannot type), a notification says why and gives the line to paste.
- `NEEDS USER` and `SCOPE CLOSED` are yours: a macOS notification says so, in any mode, and the count of hand-offs starts again.
- After 10 hand-offs in a row with no prompt from you, it waits for you: the next hand-off is held, a notification says so, and the workspace's row shows `continue`. What you type to either agent starts the count again, as does `continue`: a prompt (also one typed while it works), a command (`/model`, `/peer-coding …`, `!ls`; not `/compact`) or a paste. A message that is one line starting with a cue (pasted or not) counts as the relay's, not yours.
- `notify`: nothing is typed; a notification gives you the line to paste.
- **Context guard (Claude).** A workspace's Claude whose context is at least the workspace's `Claude compacts at` share full (50% unless set; `Claude compacts at` in the workspace's actions goes 50, 60, 70, 80 percent, off) compacts itself after its hand-off has been passed, with the relay on (`auto`), at the point that costs least: at once if its context is near the window (80%, or the setting if higher); otherwise just before its prompt cache expires, if it is still idle then. A hand-back from Codex, a prompt or a command you type to it (`/model`, `!ls`), or a switch to another conversation, within the cache's life keeps its whole context (read again from the cache, at a tenth of the price); a compaction made while the cache is still warm is meant to read it from the cache too (the event log says what each one read from the cache and afresh), and its next turn starts small. The cache's life is read from its own records (the last reply that wrote to the cache: an hour, or five minutes; five when none says) and counted from when its last request was sent: it compacts 5 minutes before an hour's cache ends, 90 seconds before a shorter one's. Woken late (the Mac asleep), it still compacts, and the log says it was after the cache expired. Never after a cue for you (NEEDS USER, SCOPE CLOSED): it waits for your answer as it is.
  - Claude compacts itself, from this plugin running in it (where this plugin is installed for that Claude's account): once its turn ends with READY FOR CODEX and the relay has taken up that line (its ledger step; within two minutes, else it waits for a later hand-off), and while that turn is still its last and the session the same conversation, it compacts between turns, told what to keep (what the workspace is for, the peer-coding branch and worktree, the round, where the records are, what you decided, the cue it last sent). Nothing is typed into its pane. A wait for the cache's end is dropped when this plugin reloads or the session ends; the event log says, for instance, `Claude compacted (before its prompt cache expired, idle 54m; its context was 61% full; it read 610k tokens from the cache, 3k afresh)`.
  - Codex compacts itself, by its own measure, as it does outside a workspace (its records show it compacting in conversations no workspace ever held): the relay types nothing into Codex but hand-offs.
  - While an agent compacts it is busy (Claude's registry says so, for its own compaction too; Codex runs it as a task), so the relay waits before typing into it. The share is of the whole window: on a 1M-token Claude, 50% is 500k tokens. A compaction is never counted as your typing.
- What it reads: for a workspace with the relay on, from each agent's own records (its Claude transcript or Codex rollout, the last 600 lines), only how its last turn stands: finished or under way, its id and time, and the last cue line of its final reply; and when you last typed to that agent (Claude Code marks what was typed; a one-line message starting with a cue is the relay's, and a compaction, a background task's notice or an interrupt is not yours). Nothing else of what was said leaves that pipeline (`jq`, macOS's own).
- It runs in whichever Claude Code session collects (every 30 s, or 4 s while a pane is shown), so a hand-off reaches the other agent within about half a minute, as long as some Claude Code session with this plugin is open (the workspace's own Claude counts).
- The peer-coding rules (Archetype's playbook) say the relay stays with the owner: this is that, done by your own tool, which you switch on per workspace; it passes only the agents' own cue lines, unchanged.

### Drift check

A workspace made for a purpose is checked at milestones: after every 4 hand-offs passed since its last check (`Check` in its actions goes every 4, every 8, off) and when the agents close their scope; `Check now` checks at once.

- One model call (Opus, from a Claude session of the workspace's own account, so its records never go out through another): what the owner said the workspace is for, then what the agents wrote, as one block of data: their latest hand-offs (from the relay's event log: passed, told to you, and their own NEEDS USER and SCOPE CLOSED) and their peer-coding records (the copy in the worktree on the branch the latest hand-off names, else the copy written last: CURRENT.md, the latest round's notes, the alignment and findings, each cut, and the branch's last 15 commit subjects). Nothing outside the repository and its worktrees is read (a symbolic link leading out is passed over, a linked file never read), and no program a repository's settings name runs.
- With nothing the agents wrote (no hand-off logged, no records) there is no call: nothing to check yet. Too little to judge is said as on track, never as an alarm.
- Its verdict: on track; drifting (off into what the purpose did not ask for: a rabbit hole, scope creep, polishing past the need); unclear need (the purpose as stated may be mistaken or too thin for what the agents found: restate it); needs owner (a decision only you can make is blocking or being guessed at). A brief of a few plain sentences, and for anything but on track the one question or action for you.
- It is kept on the workspace (its row says `check: …`), added to the event log (the ops screen shows it; a click opens the workspace), and, unless on track, notified: the agents may need your help. A check that could not be done says why, and the next comes at the next milestone.
- Limits: the check judges what the agents recorded, and cannot see work they did not record. What they write is data to judge, and the model is told to ignore anything in it that tells it what to answer; still, text written to steer it can sway the verdict, including to on track. Each check is one Opus call on your account.

## Ops screen

`Ops screen`, beside `+ New workspace` in the pane (in Terminal.app), opens a full-screen console in a Terminal window of its own (`node ops/ops.mjs --account <the account the pane shows>`, from this plugin's folder; `a` there switches to every account and back; Node 22.18 or later, which runs TypeScript as it is: an older one says so in that window):

- **Nodes:** each workspace, its Claude and Codex (working or idle), a packet crossing the link after each hand-off, the relay's mode, its count of hand-offs in a row, and what it last did; `OPERATOR INPUT REQUIRED` when it waits for you.
- **Grid:** the repositories, an agent a cell.
- **Event log:** what the relay did (hand-offs, what is yours, holds), Claude's compactions and sessions starting, working, going idle and ending.
- **Clicks open what a row is about:** a running workspace's window (brought up where a terminal is attached to it, else a new Terminal window attached to it), at Claude's or Codex's pane by the side of the agent row you click, or a session's own Terminal tab. A workspace not running is left to /sessions, which checks it before it opens. The bottom line says what it did.
- `t` changes the theme (MATRIX, AMBER, CYBER, ICE, PAPER; each paints its own background, kept in `~/Library/Application Support/live-sessions/ops.json`); `q` quits. The screen never scrolls: rows are cut to the window, the mouse is taken.
- It reads only: the shared snapshot (of this plugin's version) and the relay's event log (`~/Library/Caches/live-sessions/events.jsonl`: the collecting session adds a line for each hand-off passed or not, each cue for you and each hold; a workspace's Claude adds one for each compaction of its own; past 1000 lines it moves to `events.jsonl.1`). A click acts only on a workspace whose tmux session is running and marked as its own; one not running is opened from /sessions, which checks it first. However it ends (a key, a signal, an error), the terminal is given back as it was.

## Where it reads from

Nothing in Claude's or Codex's own files is ever written. Collecting reads, and writes only the mod's own shared snapshot and the relay's event log, with one exception: for a workspace whose relay you turned on, it also types each hand-off into the other agent's pane and records that in the workspaces file and the relay's own folder (The relay, above). Otherwise the only actions on a session are the ones you press: bringing a tab to the front, attaching, `To background` (which ends and relaunches the session you chose), and opening a workspace.

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
claude plugin test .                                         # 143 tests
npx -p typescript@5.6.3 tsc -p .                             # after one load, which lays down .claude-plugin/types
node --experimental-strip-types tests/host-check.mjs [2d] [--slow]   # on this Mac: SQL, pipelines, a full collection, the move script on throwaway processes, workspaces and the relay on a private tmux server (reading no tmux.conf), the checkout script on throwaway repositories
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-terminal.mjs    # a Terminal window: move a throwaway session to the background
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-workspace.mjs   # a Terminal window: open a throwaway workspace (private tmux server), hide it, agents keep running
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-relay.mjs       # the real Claude and Codex on a private tmux server: first prompts, turns read, lines typed and taken (a few short turns)
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-bring.mjs       # the real Claude and Codex on a private tmux server: each runs a turn, is closed where it ran and resumed in a workspace, its conversation kept (four short turns)
E2E_TRUSTED_DIR=<a trusted folder> node --experimental-strip-types tests/e2e-solo.mjs        # the real Claude and Codex, each alone in a workspace of one agent on a private tmux server: its one-agent first prompt taken and answered (two short turns)
```
