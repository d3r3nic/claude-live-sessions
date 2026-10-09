// A machine with live, stale and reused-pid Claude sessions and Codex on two homes.
import type { FsEntry } from 'claude-code'

export const HOME = '/Users/u'
export const NOW = Date.UTC(2026, 9, 9, 15, 40, 0)
export const RESUMED = 'b74cce56-f549-4fbe-8849-899d79ab8b2c'
export const RESUMED_A = '1cdaec1d-0ec7-4f0a-811f-5c29c9bcb3b7'
export const HELD = '7c6d3e24-0285-4409-9d55-1d32aa33f6d0'

const CODEX_BIN = '/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex'

/** `pgrep -x codex`: every process named codex, terminal or not. */
export const PGREP = ['201', '202', '204', '206', '207', '208', '209', '210', '211', ''].join('\n')

/** `ps -ww -o PS_COLUMNS` under TZ=UTC, one line per pid. */
export const PS_LINES: Record<number, string> = {
  101: '  101 ttys004  S+ Fri Oct  9 15:33:30 2026     claude --dangerously-skip-permissions',
  102: '  102 ??       Ss Thu Oct  8 15:50:35 2026     /Users/u/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host',
  103: '  103 ttys009  S+ Wed Oct  7 09:00:00 2026     /usr/bin/vim notes.txt',
  104: '  104 ttys022  S+ Thu Oct  8 15:50:35 2026     claude --dangerously-skip-permissions --permission-mode=plan',
  201: `  201 ttys000  S+ Wed Sep 23 21:54:00 2026     ${CODEX_BIN}`,
  202: `  202 ttys001  S+ Mon Oct  5 14:00:00 2026     ${CODEX_BIN} resume ${RESUMED}`,
  // the node wrapper is not named codex, so pgrep never lists it
  203: `  203 ttys001  S+ Mon Oct  5 14:00:00 2026     node /opt/homebrew/bin/codex resume ${RESUMED}`,
  204: `  204 ??       Ss Mon Oct  5 14:00:00 2026     ${CODEX_BIN} app-server --listen unix://`,
  206: `  206 ttys003  S+ Wed Sep 23 21:54:10 2026     ${CODEX_BIN} -c model=o3 login`,
  207: `  207 ttys045  S+ Thu Oct  8 10:00:00 2026     ${CODEX_BIN} resume ${RESUMED_A}`,
  208: `  208 ttys033  S+ Thu Oct  8 09:00:00 2026     /Applications/My Tools/codex --cd=../projects`,
  // the desktop app's own codex: no terminal
  209: '  209 ??       Ss Mon Oct  5 14:00:00 2026     /Applications/ChatGPT.app/Contents/Resources/codex',
  210: `  210 ttys040  S+ Fri Oct  9 15:00:00 2026     ${CODEX_BIN} exec fix the build`,
  // a prompt that begins with a subcommand's word is still a session
  211: `  211 ttys041  S+ Fri Oct  9 15:10:00 2026     ${CODEX_BIN} -m gpt help me read this`,
}

/** ENV_SCRIPT's output for the codex terminals: pid, CODEX_HOME, PWD. */
export const ENV_LINES: Record<number, string> = {
  201: '201\t\t/Users/u/dev/web-app',
  202: '202\t/Users/u/.codex-work\t/Users/u/dev/api',
  207: '207\t\t/Users/u/dev/web-app',
  208: '208\t\t/Users/u/dev',
  210: '210\t\t/Users/u/dev/build',
  211: '211\t\t/Users/u/dev/r\\303\\251sum\\303\\251',
}

/** `lsof -a -p <terminals> -Fpn`: 201 runs its thread in-process, so it holds the rollout. */
export const LSOF = [
  'p201',
  'fcwd',
  'n/Users/u/dev/web-app',
  'f12',
  `n/Users/u/.codex/sessions/2026/09/24/rollout-2026-09-24T07-30-15-${HELD}.jsonl`,
  'p207',
  'f3',
  'n/dev/ttys045',
  '',
].join('\n')

/** What git says per directory: two repositories with remotes, one worktree; the rest are plain folders. */
export const GIT: Record<string, { rev: string; remotes: string[] }> = {
  '/Users/u/dev/web-app': {
    rev: '/Users/u/dev/web-app\n/Users/u/dev/web-app/.git\nmain\n',
    remotes: ['remote.origin.url git@github.com:Acme/web-app.git'],
  },
  '/Users/u/dev/build': {
    rev: '/Users/u/dev/build\n/Users/u/dev/web-app/.git\nfix/build\n',
    remotes: ['remote.origin.url git@github.com:Acme/web-app.git'],
  },
  '/Users/u/dev/api': {
    rev: '/Users/u/dev/api\n/Users/u/dev/api/.git\nmain\n',
    remotes: ['remote.fork.url https://github.com/someone/api.git', 'remote.origin.url https://github.com/Acme/api.git'],
  },
  '/Users/u/dev/api/src': {
    rev: '/Users/u/dev/api\n/Users/u/dev/api/.git\nmain\n',
    remotes: ['remote.fork.url https://github.com/someone/api.git', 'remote.origin.url https://github.com/Acme/api.git'],
  },
}

/**
 * The working directories files record lately (RECENT_SCRIPT), oldest first.
 * WORKER started in ~ but works in api, with passing visits to a scratch
 * folder; the desktop thread `b` ran its commands in the web-app worktree.
 */
export const RECENT: Record<string, string[]> = {
  '/Users/u/.claude-work/projects/-Users-u/session-104.jsonl': [
    '"cwd":"/Users/u"',
    '"cwd":"/Users/u/dev/api"',
    '"cwd":"/Users/u/dev/api/src"',
    '"cwd":"/Users/u/scratch/evidence"',
    '"cwd":"/Users/u/scratch/evidence"',
    '"cwd":"/Users/u/scratch/evidence"',
  ],
  '/rollouts/b.jsonl': ['"cwd":"file:///Users/u/dev/build"', '"cwd":"file:///Users/u/dev/build"'],
}

const registryEntry = (pid: number, fields: Record<string, unknown>) =>
  JSON.stringify({
    pid,
    sessionId: `session-${pid}`,
    cwd: '/Users/u/dev/web-app',
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: NOW - 120_000,
    ...fields,
  })

export const REGISTRY: Record<string, string> = {
  '/Users/u/.claude/sessions/101.json': registryEntry(101, {
    name: 'WEB CONSOLE',
    status: 'busy',
    procStart: 'Fri Oct  9 15:33:30 2026',
    statusUpdatedAt: NOW - 5_000,
  }),
  '/Users/u/.claude/sessions/102.json': registryEntry(102, {
    name: 'NIGHTLY',
    kind: 'bg',
    jobId: 'a1b2c3d4',
    cwd: '/Users/u',
    procStart: 'Thu Oct  8 15:50:35 2026',
  }),
  // pid 103 now belongs to vim: the start time does not match
  '/Users/u/.claude/sessions/103.json': registryEntry(103, {
    name: 'REUSED PID',
    procStart: 'Tue Sep 29 22:18:43 2026',
  }),
  // pid 999 is gone
  '/Users/u/.claude/sessions/999.json': registryEntry(999, { name: 'GONE' }),
  '/Users/u/.claude-work/sessions/104.json': registryEntry(104, {
    name: 'WORKER',
    cwd: '/Users/u',
    procStart: 'Thu Oct  8 15:50:35 2026',
  }),
}

/** A top-level thread as threadQuery selects it. */
const thread = (fields: Record<string, unknown>) => ({
  title: '',
  name: '',
  cwd: '/Users/u/dev/web-app',
  source: 'cli',
  originator: 'codex-tui',
  created_at_ms: NOW - 2 * 3600_000,
  updated_at_ms: NOW - 60 * 60_000,
  agents: 0,
  ...fields,
})

export const THREADS: Record<string, unknown[]> = {
  '/Users/u/.codex': [
    thread({ id: RESUMED_A, title: 'where are reports written', name: 'Find the report writer', rollout_path: '/rollouts/a.jsonl', updated_at_ms: NOW - 10_000, agents: 2 }),
    thread({ id: HELD, name: 'Execute research', created_at_ms: NOW - 9 * 86_400_000, updated_at_ms: NOW - 9 * 86_400_000 }),
    // newer in the same folder: what matching by folder alone would give 201
    thread({ id: 'g', name: 'Newer in web-app', created_at_ms: NOW - 3 * 86_400_000, updated_at_ms: NOW - 2 * 86_400_000 }),
    thread({ id: 'b', title: 'Read the handoff', name: 'Audit GitHub usage', source: 'vscode', originator: '', cwd: '/Users/u/projects', rollout_path: '/rollouts/b.jsonl', updated_at_ms: NOW - 5 * 60_000 }),
    thread({ id: 'c', title: 'old exec run', source: 'exec', originator: 'codex_exec', updated_at_ms: NOW - 2 * 3600_000 }),
    thread({ id: 'f', name: 'Ship the\nconsole', source: 'vscode', cwd: '/Users/u/projects', updated_at_ms: NOW - 20 * 3600_000 }),
    thread({ id: 'x', name: 'Fix the build', source: 'exec', originator: 'codex_exec', cwd: '/Users/u/dev/build', created_at_ms: NOW - 30 * 60_000, updated_at_ms: NOW - 20 * 60_000 }),
  ],
  '/Users/u/.codex-work': [
    thread({ id: RESUMED, title: 'go over the ai chat', name: 'API REVIEW', cwd: '/Users/u/dev/api', updated_at_ms: NOW - 3 * 3600_000 }),
  ],
}

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const file = (name: string): FsEntry => ({ name, kind: 'file', size: 600, mtimeMs: 1, isLink: false })

export const LISTINGS: Record<string, FsEntry[]> = {
  '/Users/u': [dir('.claude'), dir('.claude-work'), dir('.claude-profiles'), dir('.codex'), dir('.codex-work'), dir('projects'), file('.zshrc')],
  '/Users/u/.claude/sessions': [file('101.json'), file('102.json'), file('103.json'), file('999.json'), file('101.json.key'), dir('nested')],
  '/Users/u/.claude-work/sessions': [file('104.json')],
  '/Users/u/.codex': [file('state_4.sqlite'), file('state_5.sqlite'), file('state_5.sqlite-shm'), file('state_5.sqlite-wal'), file('config.toml'), dir('sessions')],
  '/Users/u/.codex-work': [file('state_5.sqlite'), file('auth.json')],
}
