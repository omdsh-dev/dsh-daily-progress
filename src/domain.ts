/**
 * Domain declaration and record schemas. The domain rides the host's
 * storage-domain facility (`ctx.storageDomain`) and is routed to whatever
 * backend the deployment configured (the standard web composition: json).
 *
 * Record keys are `<scope>:<date>` (see calendar.ts); V1 uses scope
 * `'default'`.
 * @module dsh-daily-progress/domain
 */

import z from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { DATE_RE } from './calendar.ts'

export const PlanItemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  origin: z.enum(['today', 'carried', 'tomorrow-write']),
})

export const DayPlanSchema = z.object({
  date: z.string().regex(DATE_RE),
  tz: z.string(),
  items: z.array(PlanItemSchema).max(50),
  updatedAt: z.string(),
})

/** The domain spec: one `plans` table holding one record per (scope, date). */
export const dailyProgressDomain = defineDomain({
  name: 'daily_progress',
  version: 1,
  tables: {
    plans: {
      valueSchema: DayPlanSchema,
    },
  },
})

export type DailyProgressDomainSpec = typeof dailyProgressDomain
