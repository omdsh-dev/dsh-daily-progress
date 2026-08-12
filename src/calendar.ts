/**
 * Calendar-key helpers with NO runtime dependencies: safe to import from
 * unit tests and browser-adjacent code alike. All date keys are the user's
 * LOCAL calendar dates (YYYY-MM-DD strings) — opaque labels, never UTC
 * instants.
 * @module @dsh-external/dsh-daily-progress/calendar
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The V1 isolation scope: per-user key prefix, `default` for single-user deployments. */
export const DEFAULT_SCOPE = 'default'

/** Table record key for one (scope, date) plan. */
export const recordKey = (scope: string, date: string): string => `${scope}:${date}`

/** Reject anything that is not YYYY-MM-DD of a real calendar day. */
export function isValidDateKey(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}
