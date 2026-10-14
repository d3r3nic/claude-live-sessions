// End to end with the real `claude`, on a private tmux server (never the person's own, and reading no tmux.conf): a
// Claude session brings itself into a workspace, as the plugin does it from that session's own pane. It runs a turn;
// the workspace's pane is made by the plugin's own command line, its Claude waiting while that session's process runs
// (by its pid and start time); then the session is closed between turns by a process of its own (a Stop hook, as the
// plugin's commands are its children: STOP_SCRIPT, hung up and waited for), and the workspace's Claude goes on in the
// same conversation, given its first prompt there. At no moment do two live Claude processes run that conversation.
// The prompts ask only for one fixed line back. Run from, or point E2E_TRUSTED_DIR at, a folder Claude already trusts:
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-self.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
// the plugin imports its own files without an extension, as its engine resolves them; Node needs `.ts`
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const c = await import('../hooks/collect.ts')
const w = await import('../hooks/workspaces.ts')
const r = await import('../hooks/relay.ts')
const b = await import('../hooks/bring.ts')

const HOME = process.env.HOME
const TRUSTED = realpathSync(process.env.E2E_TRUSTED_DIR ?? process.cwd())
const scratch = mkdtempSync(join(TRUSTED, 'live-sessions-self-'))
const socket = `live-sessions-e2e-self-${process.pid}`
const tmux = (...args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
const sh = (script, ...args) => spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { encoding: 'utf8', timeout: 60_000 }).stdout
const sleep = ms => new Promise(res => setTimeout(res, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const turnOf = file => (file === undefined ? undefined : r.parseTurns(sh(r.TURN_SCRIPT, file)).get(file))
const waitFor = async (what, ms, test) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1_000)) {
    const value = test()
    if (value) return value
  }
  console.log(`  (gave up waiting for ${what})`)
  return undefined
}
const exactly = line => `This is a test of moving a conversation. Reply with exactly this one line and nothing else, and do nothing more: ${line}`
const FIRST = 'READY FOR CODEX · e2e-self · first@0000000'
const AGAIN = 'READY FOR CODEX · e2e-self · again@2222222'
const ws = { id: `e2e-self-${process.pid}`, name: 'e2e self', env: '', dir: TRUSTED, createdAt: Date.now(), only: 'claude' }
// the live Claude processes whose registry entry names a conversation
const runningIt = id => readdirSync(join(HOME, '.claude', 'sessions')).filter(f => f.endsWith('.json')).filter(f => {
  try {
    const entry = JSON.parse(readFileSync(join(HOME, '.claude', 'sessions', f), 'utf8'))
    process.kill(entry.pid, 0)
    return entry.sessionId === id
  } catch {
    return false
  }
}).length

// the session closes itself from a process of its own: a Stop hook (its child, as the plugin's commands are), which
// waits for the word, then runs STOP_SCRIPT on the Claude it runs under, as the plugin closes a session brought in
writeFileSync(join(scratch, 'stop.sh'), b.STOP_SCRIPT)
writeFileSync(join(scratch, 'hook.sh'), [
  '[ -f "$0.ran" ] && exit 0; : > "$0.ran"',
  // the Claude it runs under: the nearest claude above it
  'me=; p=$PPID; while [ -n "$p" ] && [ "$p" -gt 1 ]; do case "$(/bin/ps -o comm= -p "$p")" in *claude) me=$p; break;; esac; p=$(/bin/ps -o ppid= -p "$p" | tr -d " "); done',
  `echo "$me" > ${w.shellQuote(join(scratch, 'hook-pid'))}`,
  `i=0; while [ ! -f ${w.shellQuote(join(scratch, 'go'))} ] && [ "$i" -lt 500 ]; do sleep 0.2; i=$((i + 1)); done`,
  `[ -f ${w.shellQuote(join(scratch, 'go'))} ] && [ -n "$me" ] && /bin/sh ${w.shellQuote(join(scratch, 'stop.sh'))} "$(/bin/ps -o tty= -p "$me" | tr -d " ")" ${w.shellQuote(b.JOB_COMMANDS.claude)} "$me" > ${w.shellQuote(join(scratch, 'stopped'))} 2>&1`,
  'exit 0',
].join('\n'))
writeFileSync(join(scratch, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `/bin/sh ${w.shellQuote(join(scratch, 'hook.sh'))}`, timeout: 180 }] }] } }))

let most = 0
let watching = true
try {
  tmux('new-session', '-d', '-s', 'origin', '-n', 'claude', '-c', TRUSTED, `${w.agentStart('claude', '', HOME)} --settings ${w.shellQuote(join(scratch, 'settings.json'))} -- ${w.shellQuote(exactly(FIRST))}; exec /bin/sh`)
  const claudePid = await waitFor('the claude process', 30_000, () => {
    const shell = tmux('display-message', '-p', '-t', '=origin:claude', '#{pane_pid}').stdout.trim()
    return Number(spawnSync('/usr/bin/pgrep', ['-P', shell, '-x', 'claude'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || undefined
  })
  const registry = claudePid === undefined ? undefined : await waitFor('its registry entry', 30_000, () => {
    const f = join(HOME, '.claude', 'sessions', `${claudePid}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
  })
  const id = registry?.sessionId
  const transcript = registry === undefined ? undefined : c.transcriptPath(join(HOME, '.claude'), registry.cwd, id)
  const first = await waitFor('its first turn', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.cue?.line === FIRST ? t : undefined
  })
  check('where it ran: Claude took its prompt and finished a turn', first !== undefined, first?.cue?.line)
  // from here on: never two live processes running the conversation
  void (async () => {
    while (watching) {
      most = Math.max(most, runningIt(id))
      await sleep(250)
    }
  })()
  const hookPid = await waitFor('its Stop hook', 30_000, () => {
    const f = join(scratch, 'hook-pid')
    return existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) || undefined : undefined
  })
  check('its Stop hook runs under it (a process of its own)', hookPid === claudePid, `${hookPid} ${claudePid}`)

  // the workspace, made by the plugin's own command line while this session runs: its Claude waits for it
  const since = w.processStart(sh(`${w.PROCESS_START} -p "$1"`, String(claudePid)))
  check('its start is read', since !== undefined, since)
  const made = { ...ws, threads: { claude: { id, dir: registry?.cwd } } }
  mkdirSync(dirname(w.promptPath(HOME, ws.id, 'claude')), { recursive: true })
  writeFileSync(w.promptPath(HOME, ws.id, 'claude'), exactly(AGAIN))
  spawnSync('/bin/sh', ['-c', w.openCommand(made, HOME, { socket, attach: false, waitFor: { pid: claudePid, since } })], { encoding: 'utf8' })
  const pane = `=${w.tmuxName(ws)}:peers`
  const waiting = await waitFor('the wait line', 20_000, () => tmux('capture-pane', '-p', '-t', pane).stdout.includes('Waiting for the Claude session this conversation was brought in from to close'))
  await sleep(4_000)
  // (its pane runs the wait, no Claude in front of it; its first prompt taken, held for when it goes on)
  const paneTty = tmux('display-message', '-p', '-t', pane, '#{pane_tty}').stdout.trim().slice(5)
  const inFront = spawnSync('/bin/ps', ['-t', paneTty, '-o', 'comm='], { encoding: 'utf8' }).stdout
  check('workspace: its Claude waits while that session runs, starting nothing', waiting === true && runningIt(id) === 1 && !/claude/.test(inFront) && !existsSync(w.promptPath(HOME, ws.id, 'claude')), inFront.trim().split('\n').join(' '))

  // the word: the session closes itself between turns
  writeFileSync(join(scratch, 'go'), '')
  const gone = await waitFor('the session to close', 40_000, () => {
    try {
      process.kill(claudePid, 0)
      return false
    } catch {
      return true
    }
  })
  const said = existsSync(join(scratch, 'stopped')) ? readFileSync(join(scratch, 'stopped'), 'utf8').trim() : '(nothing written)'
  check('closed by a process of its own: it exited; its terminal keeps its shell', gone === true, `STOP_SCRIPT said: ${said}`)

  const again = await waitFor('its turn in the workspace', 180_000, () => {
    const t = turnOf(transcript)
    return t?.state === 'done' && t.cue?.line === AGAIN ? t : undefined
  })
  check('workspace: Claude went on in the same conversation, its first turn kept', again !== undefined && readFileSync(transcript, 'utf8').includes(FIRST), again?.cue?.line)
  watching = false
  await sleep(500)
  check('never two live processes running the conversation', most === 1, `at most ${most}`)
} finally {
  watching = false
  // the agents end with their panes: a hang-up first (as closing them would), then a kill for one that stays
  const ttys = tmux('list-panes', '-a', '-F', '#{pane_tty}').stdout.trim().split('\n').filter(t => t.startsWith('/dev/'))
  const agents = ttys.flatMap(t => spawnSync('/bin/ps', ['-t', t.slice(5), '-o', 'pid=,comm='], { encoding: 'utf8' }).stdout.trim().split('\n'))
    .filter(l => /(claude|node)$/.test(l.trim())).map(l => Number(l.trim().split(/\s+/)[0]))
  for (const pid of agents) try { process.kill(pid, 'SIGHUP') } catch {}
  await sleep(3_000)
  for (const pid of agents) try { process.kill(pid, 'SIGKILL') } catch {}
  tmux('kill-server')
  rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, socket), { force: true })
  rmSync(w.promptPath(HOME, ws.id, 'claude'), { force: true })
  rmSync(scratch, { recursive: true, force: true })
  await sleep(2_000)
  const left = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes(socket) || l.includes(scratch))
  check('cleaned up: no tmux server, process or folder left', left.length === 0 && !existsSync(scratch), left.join(' | '))
}
process.exitCode = failures > 0 ? 1 : 0
