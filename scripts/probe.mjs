/**
 * Live-runtime probe for dsh-daily-progress P0: drives the COMPILED plugin
 * against the REAL @deepseek-ai runtime packages (the same instances the
 * running DSH process loads from profiles/node_modules), with the REAL json
 * storage backend writing to a scratch directory.
 *
 * Run: NODE_PATH=/home/lzk22/.dsh/profiles/node_modules node probe.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const DailyProgress = await import(new URL('../lib/index.js', import.meta.url).pathname)

const root = mkdtempSync(join(tmpdir(), 'dp-probe-'))
const changes = []
const backend = new JsonStorageBackend(root)

// Minimal cordis-shaped ctx for the REAL DomainFacility (it only touches
// storage.backend.get, emit, and logger — verified in its source).
const facility = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } },
  emit: (event, payload) => {
    if (event === 'domain/changed') changes.push(payload)
  },
  logger: { warn: () => {} },
}, { backend: 'json' })

// Minimal ctx for MY plugin's apply: storageDomain + httpServer + effect.
let route = null
const fakeCtx = {
  storageDomain: facility,
  httpServer: {
    register: (registered) => {
      route = registered
      return () => { route = null }
    },
  },
  effect: () => {},
}
DailyProgress.apply(fakeCtx)

if (route === null) throw new Error('plugin registered no route')

/** Drive one HTTP request through the plugin's handler with fake req/res. */
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    let status = 0
    let payload = ''
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      writeHead: (code) => { status = code },
      end: (chunk) => {
        payload = typeof chunk === 'string' ? chunk : (chunk ?? '').toString()
        let parsed = null
        try { parsed = JSON.parse(payload) } catch { /* not json */ }
        resolve({ status, parsed, raw: payload })
      },
    }
    void Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const TZ = 'Asia/Shanghai'
let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    console.log('   expected:', JSON.stringify(expected))
    console.log('   actual:  ', JSON.stringify(actual))
  }
}

// 1. Empty state: no plan today, streak 0, weekRate null.
let r = await call('GET', '/daily-progress/state?localDate=2026-08-13&tz=' + TZ)
check('empty state', { status: r.status, today: r.parsed.today, streak: r.parsed.streak, weekRate: r.parsed.weekRate },
  { status: 200, today: null, streak: 0, weekRate: null })

// 2. Loopback guard: a non-loopback Host is refused.
let blocked = await (() => new Promise((resolve, reject) => {
  let status = 0
  const req = { method: 'GET', url: '/daily-progress/state?localDate=2026-08-13', headers: { host: 'evil.example.com' } }
  const res = { writeHead: (code) => { status = code }, end: (chunk) => resolve({ status, body: String(chunk ?? '') }) }
  void Promise.resolve(route.handler(req, res)).catch(reject)
}))()
check('loopback guard', blocked.status, 403)

// 3. Add two items to today.
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'addItem', payload: { target: 'today', text: '完成 P0 验证' } })
const itemA = r.parsed.snapshot.today.items[0]
check('addItem today', { n: r.parsed.snapshot.today.items.length, text: itemA.text },
  { n: 1, text: '完成 P0 验证' })

r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'addItem', payload: { target: 'today', text: '写明日计划' } })
const itemB = r.parsed.snapshot.today.items[1]
check('addItem today #2', r.parsed.snapshot.today.items.length, 2)

// 4. Write tomorrow's plan (save button semantics: wholesale replace).
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'setTomorrow', payload: { items: [{ id: 't1', text: '给明天的自己：早起复盘' }] } })
check('setTomorrow', { n: r.parsed.snapshot.tomorrow.items.length, text: r.parsed.snapshot.tomorrow.items[0].text, id: r.parsed.snapshot.tomorrow.items[0].id },
  { n: 1, text: '给明天的自己：早起复盘', id: 't1' })

// 5. Toggle item A done: today 1/2, streak still 0, weekRate 0.5 (future-day plan excluded).
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'toggleItem', payload: { itemId: itemA.id } })
check('toggle A', { done: r.parsed.snapshot.today.items[0].done, doneAt: r.parsed.snapshot.today.items[0].doneAt !== null, streak: r.parsed.snapshot.streak, weekRate: r.parsed.snapshot.weekRate },
  { done: true, doneAt: true, streak: 0, weekRate: 0.5 })

// 6. Toggle item B done: today achieved → streak 1, weekRate 1.
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'toggleItem', payload: { itemId: itemB.id } })
check('toggle B → achieved', { streak: r.parsed.snapshot.streak, weekRate: r.parsed.snapshot.weekRate },
  { streak: 1, weekRate: 1 })

// 7. Un-toggle B: back to 0.5, streak pauses at 0 (today unachieved).
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-13', tz: TZ, op: 'toggleItem', payload: { itemId: itemB.id } })
check('un-toggle B', { done: r.parsed.snapshot.today.items[1].done, streak: r.parsed.snapshot.streak },
  { done: false, streak: 0 })

// 8. Next day 08-14 already carries the explicit tomorrow plan (setTomorrow
//    wrote it); rollover must NOT overwrite it. 08-13 was unachieved (B
//    undone), so streak pauses at 0.
r = await call('GET', '/daily-progress/state?localDate=2026-08-14&tz=' + TZ)
check('tomorrow plan survives rollover', { n: r.parsed.today.items.length, text: r.parsed.today.items[0].text, origin: r.parsed.today.items[0].origin, streak: r.parsed.streak },
  { n: 1, text: '给明天的自己：早起复盘', origin: 'tomorrow-write', streak: 0 })

// 9. clearToday: empty record blocks re-carry (idempotent rollover).
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-14', tz: TZ, op: 'clearToday', payload: {} })
check('clearToday', r.parsed.snapshot.today.items.length, 0)
r = await call('GET', '/daily-progress/state?localDate=2026-08-14&tz=' + TZ)
check('no re-carry after clear', r.parsed.today.items.length, 0)

// 10. Validation failures.
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-02-30', tz: TZ, op: 'addItem', payload: {} })
check('invalid date rejected', { status: r.status, code: r.parsed.code }, { status: 400, code: 'invalid_local_date' })
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-14', tz: TZ, op: 'toggleItem', payload: { itemId: 'ghost' } })
check('missing item rejected', { status: r.status, code: r.parsed.code }, { status: 404, code: 'item_not_found' })
r = await call('POST', '/daily-progress/mutate', { localDate: '2026-08-14', tz: TZ, op: 'addItem', payload: { target: 'today', text: '   ' } })
check('blank text rejected', { status: r.status, code: r.parsed.code }, { status: 400, code: 'empty_text' })

// 11. domain/changed events observed for every durable write:
//     addItem×2 + setTomorrow + toggle×3 + clearToday = 7 writes.
check('domain/changed emitted', changes.length, 7)

// 12. Durability: a fresh facility over the same directory sees the records.
const facility2 = new DomainFacility({
  storage: { backend: { get: (name) => (name === 'json' ? new JsonStorageBackend(root) : undefined) } },
  emit: () => {},
  logger: { warn: () => {} },
}, { backend: 'json' })
const { dailyProgressDomain } = await import(new URL('../lib/domain.js', import.meta.url).pathname)
const domain2 = await facility2.open(dailyProgressDomain)
const table2 = domain2.table('plans')
const kept = table2.get('default:2026-08-14')
check('durability across reopen', { n: kept.items.length, date: kept.date }, { n: 0, date: '2026-08-14' })
await domain2.close()

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PROBES PASSED' : `\n${failures} PROBE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
