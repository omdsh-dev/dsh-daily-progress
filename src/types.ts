/**
 * Shared wire types for the daily-progress domain. These are the shapes the
 * host routes serve and the browser widget consumes; keep them JSON-safe and
 * free of implementation classes.
 */

/** Origin of one plan item. */
export type ItemOrigin = 'today' | 'carried' | 'tomorrow-write'

/** One checklist entry of a daily plan. */
export interface PlanItem {
  /** Stable id (nanoid); preserved when an item is carried into tomorrow. */
  id: string
  /** Trimmed, non-empty text, at most 500 chars. */
  text: string
  done: boolean
  /** ISO 8601 instant of the last check, null when undone. */
  doneAt: string | null
  origin: ItemOrigin
}

/** One user-local calendar day of plans. `date` is the user's LOCAL date (YYYY-MM-DD), never UTC. */
export interface DayPlan {
  date: string
  /** IANA zone the writing client reported; recorded for display only, never used in date math. */
  tz: string
  items: PlanItem[]
  updatedAt: string
}

/** One week heatmap cell (Monday-first). `rate` is null when the day has no plan. */
export interface WeekCell {
  date: string
  total: number
  done: number
  rate: number | null
}

/** The snapshot the widget renders: today, tomorrow, week cells, streak, week rate. */
export interface Snapshot {
  today: DayPlan | null
  tomorrow: DayPlan | null
  week: WeekCell[]
  /** Consecutive achieved days ending today (if today achieved) or yesterday. */
  streak: number
  /** Week done/total across all items of the current week; null when the week has no items yet. */
  weekRate: number | null
}

/** Mutation request body. */
export interface MutateRequest {
  /** User-local calendar date of the requesting client, YYYY-MM-DD. */
  localDate: string
  /** IANA zone of the requesting client (recorded only). */
  tz: string
  op: 'toggleItem' | 'addItem' | 'removeItem' | 'editItemText' | 'setTomorrow' | 'clearToday'
  payload: Record<string, unknown>
}

/** Business error codes the routes return. */
export type MutateErrorCode =
  | 'invalid_local_date'
  | 'invalid_tz'
  | 'unknown_op'
  | 'invalid_payload'
  | 'item_not_found'
  | 'plan_locked'
  | 'too_many_items'
  | 'empty_text'
  | 'internal'

export type MutateResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; code: MutateErrorCode; message: string }
