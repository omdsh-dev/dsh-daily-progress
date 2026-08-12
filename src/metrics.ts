/**
 * Pure metric and calendar logic. No IO, no host services: every function is
 * a deterministic fold over DayPlan values, unit-tested in tests/metrics.test.ts.
 *
 * Calendar convention: all date keys are the USER's local calendar dates
 * (YYYY-MM-DD strings). Arithmetic uses Date.UTC exclusively so DST gaps and
 * timezone offsets can never shift a day boundary — the same trap that bit
 * pon-honor-system (UTC formatting vs local-day comparison) is avoided by
 * treating date keys as opaque calendar labels.
 * @module @dsh-external/dsh-daily-progress/metrics
 */

import type { DayPlan, WeekCell } from './types.ts'

/** Parse a YYYY-MM-DD key into UTC-anchored y/m/d parts. Assumes valid input. */
function parts(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number)
  return { y, m, d }
}

/** Format y/m/d parts back into a YYYY-MM-DD key. */
function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Add (possibly negative) calendar days to a date key. */
export function addDays(key: string, delta: number): string {
  const { y, m, d } = parts(key)
  const shifted = new Date(Date.UTC(y, m - 1, d + delta))
  return format(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

/** Monday-first index of the week day (Mon=0 … Sun=6) for a date key. */
function mondayFirstDow(key: string): number {
  const { y, m, d } = parts(key)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return (dow + 6) % 7
}

/** The seven date keys of the Monday-first week containing `today`, oldest first. */
export function weekKeys(today: string): string[] {
  const monday = addDays(today, -mondayFirstDow(today))
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

/** Completion rate of one plan: null when the day has no plan, 0..1 otherwise. */
export function dayRate(plan: DayPlan | null): number | null {
  if (plan === null) return null
  if (plan.items.length === 0) return 0
  return plan.items.filter((item) => item.done).length / plan.items.length
}

/** An achieved day: has at least one item and every item is done. */
export function isAchieved(plan: DayPlan | null): boolean {
  return plan !== null && plan.items.length > 0 && plan.items.every((item) => item.done)
}

/**
 * Consecutive achieved days ending at `today` when today is achieved, or at
 * yesterday otherwise — an unachieved today PAUSES the streak, it does not
 * break it. Walks at most `cap` days back.
 */
export function computeStreak(lookup: (date: string) => DayPlan | null, today: string, cap = 366): number {
  let cursor = isAchieved(lookup(today)) ? today : addDays(today, -1)
  let streak = 0
  while (streak < cap && isAchieved(lookup(cursor))) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

/**
 * Build the week heatmap cells for the Monday-first week containing `today`.
 * Future days (after today) render as plan-less cells: plans already written
 * for them exist but do not count toward this week's rate yet.
 */
export function weekCells(lookup: (date: string) => DayPlan | null, today: string): WeekCell[] {
  return weekKeys(today).map((date) => {
    if (date > today) return { date, total: 0, done: 0, rate: null }
    const plan = lookup(date)
    if (plan === null) return { date, total: 0, done: 0, rate: null }
    const total = plan.items.length
    const done = plan.items.filter((item) => item.done).length
    return { date, total, done, rate: total === 0 ? 0 : done / total }
  })
}

/**
 * Week completion rate: all items of the current week through TODAY,
 * done/total; null when no items exist yet. Future days of the week are
 * deliberately excluded — tomorrow's undone plan must not lower today's rate.
 */
export function weekRate(lookup: (date: string) => DayPlan | null, today: string): number | null {
  const cells = weekCells(lookup, today)
  let total = 0
  let done = 0
  for (const cell of cells) {
    total += cell.total
    done += cell.done
  }
  return total === 0 ? null : done / total
}

/**
 * Lazy cross-day rollover: when today has no record yet, yesterday's undone
 * items are carried into today as `origin:'carried'`. Idempotent — returns
 * the existing record untouched when one already exists. Returns the plan to
 * store (or null for a no-op) and whether a record was created.
 */
export function rollover(
  yesterday: DayPlan | null,
  today: DayPlan | null,
  todayKey: string,
  tz: string,
  nowIso: string,
): { plan: DayPlan | null; created: boolean } {
  if (today !== null) return { plan: null, created: false }
  const carried = (yesterday?.items ?? []).filter((item) => !item.done)
  if (carried.length === 0) return { plan: null, created: false }
  return {
    plan: {
      date: todayKey,
      tz,
      items: carried.map((item) => ({ ...item, origin: 'carried' as const })),
      updatedAt: nowIso,
    },
    created: true,
  }
}
