/**
 * Minimal ambient declarations for the host packages this plugin consumes.
 *
 * The real @deepseek-ai/* packages are internal (not on the public npm
 * registry) and are resolved at RUNTIME by the DSH host that loads this
 * plugin. These declarations exist so the repository typechecks standalone;
 * they are deliberately loose (any-typed generics) — the authoritative
 * contract check is the live-runtime probe (`pnpm run probe` in the DSH
 * process) plus the host's own tsdown build in CI.
 */

declare module '@deepseek-ai/dsh-storage-domain' {
  export interface DomainTableSpec {
    readonly valueSchema: unknown
    readonly __key?: string
  }
  export interface DomainSpec {
    readonly name: string
    readonly version: number
    readonly global?: unknown
    readonly tables: Record<string, DomainTableSpec>
  }
  export function defineDomain<S extends DomainSpec>(spec: S): S
  export interface KvTable<K extends string, V> {
    get(key: K): V | undefined
    put(key: K, value: V): Promise<void>
    delete(key: K): Promise<boolean>
    entries(): IterableIterator<[K, V]>
    keys(): IterableIterator<K>
    readonly size: number
  }
  export interface Domain<S> {
    table(name: string): KvTable<string, any>
    close(): Promise<void>
  }
  export type DomainChanged = unknown
}

declare module 'cordis' {
  export interface Context {
    storageDomain: {
      open<S extends import('@deepseek-ai/dsh-storage-domain').DomainSpec>(
        spec: S,
      ): Promise<import('@deepseek-ai/dsh-storage-domain').Domain<S>>
    }
    httpServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
    effect(disposer: () => void | Promise<void> | (() => void | Promise<void>), label?: string): void
  }
}
