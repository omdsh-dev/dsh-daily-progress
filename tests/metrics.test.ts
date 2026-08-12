import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  computeStreak,
  dayRate,
  isAchieved,
  rollover,
  weekCells,
  weekKeys,
  weekRate,
} from '../src/metrics.ts'
import { isValidDateKey } from '../src/calendar.ts'
import type { DayPlan } from '../src/types.ts'

function plan(date: string, states: Array<[text: string, done: boolean]>): DayPlan {
  return {
    date,
    tz: 'Asia/Shanghai',
    items: states.map(([text, done], index) => ({
      id: `${date}-${index}`,
      text,
      done,
      doneAt: done ? '2026-08-13T03:00:00.000Z' : null,
      origin: 'today',
    })),
    updatedAt: '2026-08-13T03:00:00.000Z',
  }
}

describe('calendar arithmetic', () => {
  it('adds and subtracts days across month boundaries', () => {
    assert.equal(addDays('2026-07-31', 1), '2026-08-01')
    assert.equal(addDays('2026-08-01', -1), '2026-07-31')
    assert.equal(addDays('2026-02-28', 1), '2026-03-01')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })

  it('builds Monday-first weeks containing the given day', () => {
    // 2026-08-13 is a Thursday; the week runs 08-10 (Mon) .. 08-16 (Sun).
    assert.deepEqual(weekKeys('2026-08-13'), [
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ])
    // A Sunday belongs to the week that started six days earlier.
    assert.equal(weekKeys('2026-08-16')[0], '2026-08-10')
  })

  it('validates date keys strictly', () => {
    assert.equal(isValidDateKey('2026-08-13'), true)
    assert.equal(isValidDateKey('2026-02-30'), false)
    assert.equal(isValidDateKey('2026-8-13'), false)
    assert.equal(isValidDateKey('abc'), false)
  })
})

describe('rates and achievement', () => {
  it('dayRate is null without a plan, 0 for an empty plan, 1 when all done', () => {
    assert.equal(dayRate(null), null)
    assert.equal(dayRate(plan('2026-08-13', [])), 0)
    assert.equal(dayRate(plan('2026-08-13', [['a', false], ['b', true]])), 0.5)
    assert.equal(dayRate(plan('2026-08-13', [['a', true]])), 1)
  })

  it('isAchieved requires at least one item and 100% done', () => {
    assert.equal(isAchieved(null), false)
    assert.equal(isAchieved(plan('2026-08-13', [])), false)
    assert.equal(isAchieved(plan('2026-08-13', [['a', false]])), false)
    assert.equal(isAchieved(plan('2026-08-13', [['a', true]])), true)
  })
})

describe('streak', () => {
  it('counts consecutive achieved days ending today when today is achieved', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-11', plan('2026-08-11', [['a', true]])],
      ['2026-08-12', plan('2026-08-12', [['a', true]])],
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(computeStreak(lookup, '2026-08-13'), 3)
  })

  it('an unachieved today PAUSES the streak without breaking it', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-11', plan('2026-08-11', [['a', true]])],
      ['2026-08-12', plan('2026-08-12', [['a', true]])],
      ['2026-08-13', plan('2026-08-13', [['a', false]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(computeStreak(lookup, '2026-08-13'), 2)
  })

  it('a gap breaks the streak', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-11', plan('2026-08-11', [['a', true]])],
      // 08-12 missing entirely
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(computeStreak(lookup, '2026-08-13'), 1)
  })

  it('empty days never count', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-12', plan('2026-08-12', [])],
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(computeStreak(lookup, '2026-08-13'), 1)
  })
})

describe('week', () => {
  it('cells mark plan-less days as null and compute rates otherwise', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-10', plan('2026-08-10', [['a', true], ['b', false]])],
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    const cells = weekCells(lookup, '2026-08-13')
    assert.equal(cells.length, 7)
    assert.deepEqual(
      { ...cells[0], rate: Math.round((cells[0].rate ?? -1) * 100) / 100 },
      { date: '2026-08-10', total: 2, done: 1, rate: 0.5 },
    )
    assert.equal(cells[1]!.rate, null)
    assert.equal(cells[3]!.rate, 1)
  })

  it('weekRate is item done/total across the week, null when empty', () => {
    const days = new Map<string, DayPlan>([
      ['2026-08-10', plan('2026-08-10', [['a', true], ['b', false]])],
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(weekRate(lookup, '2026-08-13'), 2 / 3)
    assert.equal(weekRate(() => null, '2026-08-13'), null)
  })

  it('future days of the week do not count into weekRate or heatmap cells', () => {
    // Thursday 08-13; 08-14 (tomorrow, same week) has a written plan with
    // nothing done — it must not drag down today's week rate.
    const days = new Map<string, DayPlan>([
      ['2026-08-13', plan('2026-08-13', [['a', true]])],
      ['2026-08-14', plan('2026-08-14', [['x', false], ['y', false], ['z', false]])],
    ])
    const lookup = (date: string) => days.get(date) ?? null
    assert.equal(weekRate(lookup, '2026-08-13'), 1)
    const cells = weekCells(lookup, '2026-08-13')
    assert.equal(cells[3]!.rate, 1)      // today
    assert.equal(cells[4]!.rate, null)   // tomorrow: future, excluded
    assert.equal(cells[4]!.total, 0)
  })
})

describe('rollover', () => {
  it('carries yesterday undone items into a missing today, idempotently', () => {
    const yesterday = plan('2026-08-12', [['a', false], ['b', true], ['c', false]])
    const first = rollover(yesterday, null, '2026-08-13', 'Asia/Shanghai', '2026-08-13T00:00:00.000Z')
    assert.equal(first.created, true)
    assert.deepEqual(first.plan?.items.map((item) => item.text), ['a', 'c'])
    assert.equal(first.plan?.items.every((item) => item.origin === 'carried' && !item.done), true)

    // A record now exists: rollover is a no-op even if all of yesterday was undone.
    const second = rollover(yesterday, first.plan!, '2026-08-13', 'Asia/Shanghai', '2026-08-13T00:00:01.000Z')
    assert.equal(second.created, false)
    assert.equal(second.plan, null)
  })

  it('creates nothing when yesterday is clean or missing', () => {
    assert.equal(rollover(null, null, '2026-08-13', 'Asia/Shanghai', 'now').created, false)
    const clean = plan('2026-08-12', [['a', true]])
    assert.equal(rollover(clean, null, '2026-08-13', 'Asia/Shanghai', 'now').created, false)
  })
})
