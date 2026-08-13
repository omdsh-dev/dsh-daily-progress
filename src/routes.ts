/**
 * HTTP surface for the widget. External plugins cannot extend the core
 * `/api` RPC map, so this plugin serves its own same-origin routes and the
 * browser client consumes them with plain fetch + optimistic updates.
 *
 * Route tree (mounted at prefix `/daily-progress` by the host plugin):
 *   GET  /daily-progress/state?localDate=YYYY-MM-DD&tz=IANA   → Snapshot
 *   POST /daily-progress/mutate                                → MutateResult
 *
 * All handlers are loopback-guarded (the Host header must be loopback) — the
 * same posture as the connection carrier's `/api` fence, cheap for a plugin.
 *
 * Record discipline: domain records are immutable — every mutation builds a
 * NEW DayPlan object and stores it; nothing is edited in place.
 * @module dsh-daily-progress/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { addDays, computeStreak, rollover, weekCells, weekRate } from './metrics.ts'
import { DEFAULT_SCOPE, isValidDateKey, recordKey } from './calendar.ts'
import type { DailyProgressDomainSpec } from './domain.ts'
import type { DayPlan, MutateRequest, Snapshot } from './types.ts'

const MAX_BODY_BYTES = 64 * 1024
const MAX_ITEMS = 50
const MAX_TEXT = 500

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, code, message })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Accept only loopback Host authorities; same-origin browser fetches always carry them here. */
function isLoopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (raw === undefined) return false
  const host = raw.replace(/^\[|\](?=:)?/g, '').split(':')[0]!
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return null
  return trimmed
}

export interface DailyProgressHandlers {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/** Everything one request needs; resolved once per request. */
interface Session {
  plans: KvTable<string, DayPlan>
  lookup: (date: string) => DayPlan | null
  store: (plan: DayPlan) => Promise<void>
}

/**
 * Build the route handlers over the (async) domain open. The table handle is
 * resolved lazily on first use and cached — Domain.table returns a stable
 * handle, and reads from it are synchronous in-memory snapshots.
 */
export function createHandlers(domainPromise: Promise<Domain<DailyProgressDomainSpec>>): DailyProgressHandlers {
  let tablePromise: Promise<KvTable<string, DayPlan>> | null = null
  const session = async (): Promise<Session> => {
    if (tablePromise === null) {
      tablePromise = domainPromise.then((domain) => domain.table('plans'))
    }
    const plans = await tablePromise
    return {
      plans,
      lookup: (date) => plans.get(recordKey(DEFAULT_SCOPE, date)) ?? null,
      store: (plan) => plans.put(recordKey(DEFAULT_SCOPE, plan.date), plan),
    }
  }

  /**
   * Lazy, idempotent cross-day rollover: when today has no record yet and
   * yesterday has undone items, materialize today's plan with them carried
   * over. A record that exists (even an empty one from clearToday) is never
   * touched again — that is what makes re-rollover impossible.
   */
  function ensureToday(s: Session, todayKey: string, tz: string): DayPlan {
    const existing = s.lookup(todayKey)
    if (existing !== null) return existing
    const created = rollover(
      s.lookup(addDays(todayKey, -1)),
      null,
      todayKey,
      tz,
      new Date().toISOString(),
    )
    if (created.plan !== null) {
      void s.store(created.plan)
      return created.plan
    }
    return { date: todayKey, tz, items: [], updatedAt: new Date().toISOString() }
  }

  function buildSnapshot(s: Session, todayKey: string, tz: string): Snapshot {
    ensureToday(s, todayKey, tz)
    const tomorrowKey = addDays(todayKey, 1)
    return {
      today: s.lookup(todayKey),
      tomorrow: s.lookup(tomorrowKey),
      week: weekCells(s.lookup, todayKey),
      streak: computeStreak(s.lookup, todayKey),
      weekRate: weekRate(s.lookup, todayKey),
    }
  }

  async function handleState(req: IncomingMessage, res: ServerResponse, s: Session): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const localDate = url.searchParams.get('localDate')
    const tz = url.searchParams.get('tz') ?? 'UTC'
    if (localDate === null || !isValidDateKey(localDate)) {
      return fail(res, 400, 'invalid_local_date', 'localDate must be a valid YYYY-MM-DD')
    }
    sendJson(res, 200, buildSnapshot(s, localDate, tz))
  }

  async function handleMutate(req: IncomingMessage, res: ServerResponse, s: Session): Promise<void> {
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return fail(res, 400, 'invalid_payload', 'body must be valid JSON under 64KiB')
    }
    const request = body as Partial<MutateRequest>
    if (
      typeof request !== 'object' || request === null
      || typeof request.localDate !== 'string' || !isValidDateKey(request.localDate)
    ) {
      return fail(res, 400, 'invalid_local_date', 'localDate must be a valid YYYY-MM-DD')
    }
    const tz = typeof request.tz === 'string' && request.tz.length > 0 && request.tz.length <= 64
      ? request.tz
      : 'UTC'
    const payload = (request.payload ?? {}) as Record<string, unknown>
    const todayKey = request.localDate
    const tomorrowKey = addDays(todayKey, 1)
    const nowIso = new Date().toISOString()
    ensureToday(s, todayKey, tz)

    /** The effective plan for a date, creating an empty record when absent. */
    const current = (date: string): DayPlan => s.lookup(date) ?? { date, tz, items: [], updatedAt: nowIso }
    const touch = (plan: DayPlan): DayPlan => ({ ...plan, updatedAt: nowIso })

    switch (request.op) {
      case 'toggleItem': {
        // Only the user's today is ever toggleable; history and tomorrow lock.
        const plan = current(todayKey)
        const itemId = payload.itemId
        if (typeof itemId !== 'string') return fail(res, 400, 'invalid_payload', 'itemId required')
        const target = plan.items.find((item) => item.id === itemId)
        if (target === undefined) return fail(res, 404, 'item_not_found', `no item ${itemId} in today`)
        const next = touch(plan)
        next.items = plan.items.map((item) => item.id === itemId
          ? { ...item, done: !item.done, doneAt: item.done ? null : nowIso }
          : item)
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      case 'addItem': {
        const isTomorrow = payload.target === 'tomorrow'
        const date = isTomorrow ? tomorrowKey : todayKey
        const text = normalizeText(payload.text)
        if (text === null) return fail(res, 400, 'empty_text', 'text must be 1-500 chars')
        const plan = current(date)
        if (plan.items.length >= MAX_ITEMS) {
          return fail(res, 400, 'too_many_items', `at most ${MAX_ITEMS} items per day`)
        }
        const next = touch(plan)
        next.items = [...plan.items, {
          id: randomUUID(),
          text,
          done: false,
          doneAt: null,
          origin: isTomorrow ? 'tomorrow-write' as const : 'today' as const,
        }]
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      case 'removeItem': {
        const isTomorrow = payload.target === 'tomorrow'
        const date = isTomorrow ? tomorrowKey : todayKey
        const plan = current(date)
        const itemId = payload.itemId
        if (typeof itemId !== 'string') return fail(res, 400, 'invalid_payload', 'itemId required')
        const next = touch(plan)
        next.items = plan.items.filter((item) => item.id !== itemId)
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      case 'editItemText': {
        const isTomorrow = payload.target === 'tomorrow'
        const date = isTomorrow ? tomorrowKey : todayKey
        const plan = current(date)
        const itemId = payload.itemId
        const text = normalizeText(payload.text)
        if (typeof itemId !== 'string') return fail(res, 400, 'invalid_payload', 'itemId required')
        if (text === null) return fail(res, 400, 'empty_text', 'text must be 1-500 chars')
        const target = plan.items.find((item) => item.id === itemId)
        if (target === undefined) return fail(res, 404, 'item_not_found', `no item ${itemId}`)
        const next = touch(plan)
        next.items = plan.items.map((item) => item.id === itemId ? { ...item, text } : item)
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      case 'setTomorrow': {
        // Wholesale replace of tomorrow's checklist (the panel's save button).
        const rawItems = payload.items
        if (!Array.isArray(rawItems) || rawItems.length > MAX_ITEMS) {
          return fail(res, 400, 'invalid_payload', `items must be an array of at most ${MAX_ITEMS}`)
        }
        const items: DayPlan['items'] = []
        for (const entry of rawItems) {
          if (typeof entry !== 'object' || entry === null) {
            return fail(res, 400, 'invalid_payload', 'every entry must be an object')
          }
          const { id, text } = entry as { id?: unknown; text?: unknown }
          const normalized = normalizeText(text)
          if (normalized === null) return fail(res, 400, 'empty_text', 'every item needs 1-500 char text')
          items.push({
            id: typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : randomUUID(),
            text: normalized,
            done: false,
            doneAt: null,
            origin: 'tomorrow-write' as const,
          })
        }
        const next = touch(current(tomorrowKey))
        next.items = items
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      case 'clearToday': {
        // Explicit reset; the empty record also blocks re-carrying yesterday.
        const next = touch(current(todayKey))
        next.items = []
        await s.store(next)
        return sendJson(res, 200, { ok: true, snapshot: buildSnapshot(s, todayKey, tz) })
      }
      default:
        return fail(res, 400, 'unknown_op', `unknown op ${String(request.op)}`)
    }
  }

  return {
    async handle(req, res) {
      if (!isLoopbackHost(req)) return fail(res, 403, 'internal', 'loopback only')
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const s = await session()
        if (req.method === 'GET' && url.pathname === '/daily-progress/state') {
          return await handleState(req, res, s)
        }
        if (req.method === 'POST' && url.pathname === '/daily-progress/mutate') {
          return await handleMutate(req, res, s)
        }
        return fail(res, 404, 'unknown_op', `no route ${req.method} ${url.pathname}`)
      } catch (error) {
        return fail(res, 500, 'internal', error instanceof Error ? error.message : 'internal error')
      }
    },
  }
}
