/** One running Claude Code session, read from a profile's sessions registry. */
export type ClaudeSession = {
  pid: number
  sessionId: string
  /** A background session's short id, which `claude attach` takes; '' for others. */
  jobId: string
  name: string
  /** Where the session has been working (see Snapshot). */
  cwd: string
  /** Where it started: its transcript is kept under this directory, so a resume runs from it. */
  startCwd: string
  /** As the registry spells it: `busy`, `idle`, or another word for a state that wants the person. */
  status: string
  /** `interactive`, `bg`, ... */
  kind: string
  /** The config directory's name without its dot: `claude`, `claude-work`. */
  profile: string
  /** The controlling terminal (`ttys004`), `??` for none. */
  tty: string
  /** It is the job in front of its terminal: not suspended (Ctrl+Z) and not behind another program. */
  isForeground: boolean
  /** When the status last changed (its last turn began or ended), ms since the epoch. */
  since: number
}

/** One Codex session: an open `codex` terminal, or a thread active in the last half hour. */
export type CodexSession = {
  key: string
  title: string
  /** The thread's working directory, or the terminal's where no thread was found. */
  cwd: string
  /** The Codex home's name without its dot: `codex`, `codex-work`. */
  profile: string
  /** `terminal` for an open codex TUI; otherwise the thread's source: `app`, `cli`, `exec`. */
  surface: string
  tty: string
  /** Last write to the thread, ms since the epoch; 0 for a terminal with no thread found. */
  updatedAt: number
  /** The last write, or for a terminal with no thread found, when it started. */
  lastActive: number
  /** Subagents under this thread, at any depth, that wrote in the last two minutes. */
  agents: number
  /** An open terminal matched to its thread: its process, when it started, how it was matched (CodexMatch), and whether it is an exec run. */
  pid?: number
  startedAt?: number
  match?: 'held' | 'resume' | 'folder'
  isExec?: boolean
}

/** Where a working directory sits. */
export type Place = {
  /** The repository: its remote (`github.com/owner/repo`), else its main checkout's path; '' outside any. */
  repo: string
  /** How the repository is shown: the remote's `owner/repo`, else the main checkout's folder name. */
  name: string
  /** The worktree's root; the directory itself outside any repository. */
  tree: string
  /** The worktree's branch; '' when detached or before the first commit. */
  branch: string
}

/**
 * A named project: a folder, the environment its agents start under, and
 * the tmux session (`ws-<id>`) they run in.
 */
export type Workspace = {
  /** Lowercase letters, digits and dashes, from the name. */
  id: string
  name: string
  /** '' for the default environment, else its name: `work` for ~/.claude-work and ~/.codex-work. */
  env: string
  dir: string
  createdAt: number
  /**
   * Sessions assigned to it that run outside its tmux session, by a lasting
   * id: `claude:<session id>` or `codex:<thread id>`. An entry in another
   * form (a hand edit, a later version) is kept as it is.
   */
  members?: unknown[]
  /** What it is for, in the owner's words: Claude's first prompt gets peer coding ready for it. */
  purpose?: string
  /** The one agent it runs, when the owner chose one; unset: Claude and Codex side by side. */
  only?: 'claude' | 'codex'
  /** The repository's main checkout; the agents may also work in `<checkout>-worktrees/`. */
  checkout?: string
  /** Passing each agent's cue to the other: on (`auto`), only telling the owner (`notify`), or `off`. */
  relay?: Relay
  /**
   * The conversation each agent's pane resumes when it starts: one brought
   * in from where it ran, or the one last seen in its pane. None: it starts new.
   */
  threads?: { claude?: Thread; codex?: Thread }
  /**
   * How full an agent's context may get, in percent, before it compacts once its cue is handed on;
   * 0 is off. Unset: COMPACT_AT (50).
   */
  compactAt?: number
  /** How many hand-offs in a row between two drift checks: DRIFT_EVERY (4) unless set; 0 is off. */
  checkEvery?: number
  /** The last drift check: when, and its verdict for the owner. */
  check?: { at: number; status: 'on-track' | 'drifting' | 'unclear-need' | 'needs-owner'; brief: string; ask?: string }
}

/**
 * A conversation to resume: its id, the folder it runs from, the flags that keep its permissions, and, for one
 * brought in from where it ran, when it joined the workspace (the relay types into it only after a turn since).
 */
export type Thread = { id: string; dir: string; flags?: string[]; since?: number }

export type Relay = {
  mode: 'auto' | 'notify' | 'off'
  /** Since when cues count: a turn that ended before is never passed on. */
  since: number
  /** Cues passed on since the owner last typed to an agent or answered; at the limit the relay waits for the owner. */
  streak: number
  /** When the owner last typed to an agent, as far as the count knows: a later prompt starts the count over. */
  typedAt?: number
  /** The last thing it did, said for the owner: `passed to Codex`, `needs you`. */
  status?: string
  /** When it last did something. */
  at?: number
  /** Hand-offs passed since the last drift check. */
  sinceCheck?: number
}

export type Snapshot = {
  /** Each session's `cwd` is where it has been working, which may not be where it started. */
  claude: ClaudeSession[]
  codex: CodexSession[]
  /** Each working directory above, placed. */
  places: Record<string, Place>
  /** The workspaces, as kept in their file. */
  workspaces: Workspace[]
  /** The environments on this machine: '' (the default) and each other's name. */
  envs: string[]
  /** tmux: which session and window each tty is, and the terminals attached to each session. */
  tmux: { panes: Record<string, { session: string; window: string; pane?: string }>; clients: Record<string, string[]> }
  /** When this snapshot was taken; 0 before the first. */
  checkedAt: number
  /** What could not be read, one line each. */
  problems: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'live-sessions': {
      snapshot: Snapshot
      /** This session's terminal background (`#dfdbc3`) where it can be read; '' otherwise. */
      background: string
      /** Only sessions active this recently are listed (ms); 0 lists all. */
      window: number
      /** The person's own order: per scope (`repos`, `trees:<repo>`, `items:<tree>`), keys top first. */
      order: Record<string, string[]>
      /** A move to the background pressed once: the row's key and when; a second press confirms it. */
      pendingMove: { key: string; at: number }
      /** The new-workspace form, while open. */
      draft: { isOpen: boolean; name: string; query: string; dir: string; env: string; purpose: string; error: string; bring: string[]; only: '' | 'claude' | 'codex' }
      /** The row whose actions are shown under it: `item:<key>`, `tree:<key>`, `repo:<key>` or `ws:<id>`; '' for none. */
      selected: string
      /** The git repositories found on this Mac (main checkouts), for the form to offer; [] until looked for. */
      projects: string[]
      /** The session whose workspace is being chosen: its row's key and lasting id; '' when none. */
      assigning: { key: string; member: string }
      /** A workspace is being made: a second create waits for it instead of making another. */
      creating: boolean
    }
  }
}
