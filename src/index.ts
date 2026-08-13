/**
 * dsh-daily-progress host half (cordis plugin body).
 *
 * Owns the daily-plan domain and the HTTP surface the browser widget
 * consumes. Everything here is host-plane: the storage-domain facility is a
 * process singleton (the standard web composition routes it to the json
 * backend under $DSH_HOME/storages), and the routes answer the same-origin
 * fetches of the client half.
 *
 * Export shape: function/namespace plugin (name/inject/apply, NO default —
 * a stray `export default` would collapse the module via the Loader's
 * unwrapExports and drop `inject`).
 * @module dsh-daily-progress
 */

import type { Context } from 'cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { dailyProgressDomain } from './domain.ts'
import type { DailyProgressDomainSpec } from './domain.ts'
import { createHandlers } from './routes.ts'

export const name = 'dsh-daily-progress'

/** storageDomain: durable plans; httpServer: the widget's own route prefix. */
export const inject = ['storageDomain', 'httpServer']

export function apply(ctx: Context): void {
  // Open resolves against the routed backend; handlers answer as soon as the
  // domain is open (they resolve the table lazily, per request).
  const domainPromise: Promise<Domain<DailyProgressDomainSpec>> = ctx.storageDomain.open(dailyProgressDomain)

  ctx.effect(() => async () => {
    try {
      const domain = await domainPromise
      await domain.close()
    } catch {
      // The facility closes still-open domains on unmount; a failed open has
      // nothing to close. Never let teardown throw.
    }
  }, 'daily-progress.domainClose')

  const handlers = createHandlers(domainPromise)
  const dispose = ctx.httpServer.register({
    kind: 'prefix',
    path: '/daily-progress',
    handler: (req, res) => handlers.handle(req, res),
  })
  ctx.effect(() => () => dispose(), 'daily-progress.routes')
}
