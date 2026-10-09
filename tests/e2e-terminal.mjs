// End to end on a real Terminal.app window: start a throwaway Claude session
// (haiku, one tiny prompt), move it to the background with the plugin's own
// checks and scripts, check it survives its tab closing, then remove it.
// Run from, or point E2E_TRUSTED_DIR at, a folder Claude already trusts (a new
// folder would stop at the trust prompt):
//   E2E_TRUSTED_DIR=~/some/trusted/dir node --experimental-strip-types tests/e2e-terminal.mjs
// It opens a Terminal window for about a minute.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as c from '../hooks/collect.ts'

const HOME = process.env.HOME
const WORK = mkdtempSync(join(process.env.E2E_TRUSTED_DIR ?? process.cwd(), 'live-sessions-e2e-'))
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && k !== 'CLAUDECODE'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jxa = (src, ...args) => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', src, ...args], { encoding: 'utf8' }).trim()
const registry = () =>
  readdirSync(`${HOME}/.claude/sessions`).filter(f => f.endsWith('.json')).flatMap(f => {
    try { return [JSON.parse(readFileSync(`${HOME}/.claude/sessions/${f}`, 'utf8'))] } catch { return [] }
  })
const ps = pid => c.parsePs(spawnSync('/bin/ps', ['-ww', '-o', c.PS_COLUMNS, '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout).get(pid)
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures++ }

let s, bg, tty
try {
  tty = jxa(`const t = Application('Terminal'); const tab = t.doScript("cd '${WORK}' && claude --model haiku --dangerously-skip-permissions"); delay(1); tab.tty()`).replace('/dev/', '')
  for (let i = 0; i < 60 && !s; i++) { await sleep(500); s = registry().find(r => ps(r.pid)?.tty === tty) }
  check('throwaway session started in a Terminal tab', !!s, tty)
  if (!s) throw new Error('no session')
  await sleep(4000)
  jxa(`function run(a) { const t = Application('Terminal'); for (const w of t.windows()) for (const tab of w.tabs()) if (tab.tty() === '/dev/' + a[0]) t.doScript('reply with the single word: kiwi', { in: tab }) }`, tty)
  let idle = false
  for (let i = 0; i < 80 && !idle; i++) { await sleep(500); idle = i > 6 && registry().find(x => x.pid === s.pid)?.status === 'idle' }
  check('it answered and is idle', idle)

  // the plugin's own checks, then its move
  const proc = ps(s.pid)
  check('in front of its terminal, a Claude process', c.isForeground(proc.stat) && c.isClaudeProcess(proc.args), proc.stat)
  check('its tty is a Terminal.app tab', jxa(c.HAS_TAB_SCRIPT, tty) === 'yes')
  const mode = spawnSync('/bin/sh', ['-c', c.MODE_SCRIPT, 'sh', c.transcriptPath(`${HOME}/.claude`, s.cwd, s.sessionId)], { encoding: 'utf8' }).stdout
  const flags = c.modeFlags(mode)
  check('its permission mode read from its transcript', JSON.stringify(flags) === '["--dangerously-skip-permissions"]', mode.trim())
  const command = c.backgroundCommand({ sessionId: s.sessionId, startCwd: s.cwd, profile: 'claude' }, HOME, flags)
  const out = spawnSync('/bin/sh', ['-c', c.MOVE_SCRIPT, 'sh', String(s.pid), tty, command, c.TYPE_SCRIPT], { encoding: 'utf8' })
  check('moved: hung up, resumed and attached in its own tab', out.status === 0 && out.stdout === 'typed', `exit ${out.status}`)

  let attached = false
  for (let i = 0; i < 40 && !(bg && attached); i++) {
    await sleep(500)
    const rows = JSON.parse(spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', cwd: WORK, env: CLEAN }).stdout || '[]')
    bg = rows.find(r => r.sessionId === s.sessionId && r.kind === 'background')
    attached = spawnSync('/bin/ps', ['-t', tty, '-o', 'args='], { encoding: 'utf8' }).stdout.split('\n').some(l => / attach /.test(l))
  }
  check('the same session runs in the background, its tab attached', !!bg && attached)
  const logs = bg ? spawnSync('claude', ['logs', bg.id], { encoding: 'utf8', cwd: WORK, env: CLEAN }).stdout : ''
  check('with its conversation', /kiwi/i.test(logs))

  // closing the tab hangs up its attach client
  const client = spawnSync('/bin/ps', ['-t', tty, '-o', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').find(l => / attach /.test(l))?.trim().split(/\s+/)[0]
  if (client) process.kill(Number(client), 'SIGHUP')
  await sleep(3000)
  const bgPid = registry().find(r => r.sessionId === s.sessionId && r.kind === 'bg')?.pid
  let alive = false
  try { process.kill(bgPid, 0); alive = true } catch {}
  check('it keeps running after its tab closes', alive)
} finally {
  if (tty) {
    // end whatever still runs in that tab first, so closing it never stops at "terminate running processes?"
    for (const line of spawnSync('/bin/ps', ['-t', tty, '-o', 'pid=,comm='], { encoding: 'utf8' }).stdout.split('\n')) {
      const [pid, comm = ''] = line.trim().split(/\s+/)
      if (pid && !/(^|\/)-?(zsh|bash|sh|login)$/.test(comm)) try { process.kill(Number(pid), 'SIGHUP') } catch {}
    }
    await sleep(2000)
    jxa(`function run(a) { const t = Application('Terminal'); for (const w of t.windows()) if (w.tabs().some(x => x.tty() === '/dev/' + a[0])) w.close() }`, tty)
  }
  const id = bg?.id ?? s?.sessionId.slice(0, 8)
  if (id) { spawnSync('claude', ['stop', id], { cwd: WORK, env: CLEAN }); spawnSync('claude', ['rm', id], { cwd: WORK, env: CLEAN }) }
  const project = `${HOME}/.claude/projects/${WORK.replace(/[^A-Za-z0-9]/g, '-')}`
  rmSync(project, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
  console.log('cleaned up: session stopped and removed, its folder and transcript deleted')
}
process.exitCode = failures > 0 ? 1 : 0
