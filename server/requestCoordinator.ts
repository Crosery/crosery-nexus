type Entry<T> = { value: T; expiresAt: number; staleUntil: number }

type Schedule = (task: () => void) => void

export class RequestCoordinator<T> {
  private readonly inflight = new Map<string, Promise<T>>()
  private readonly cache = new Map<string, Entry<T>>()
  private readonly ttlMs: number
  private readonly staleWhileRevalidateMs: number
  private readonly now: () => number
  private readonly schedule: Schedule
  private readonly maxEntries: number
  private revision = 0

  /**
   * `maxEntries` bounds the cache for callers whose keys come from user input (filters, pages, days): when a write
   * would exceed it, entries past their stale window go first, then the least recently written. Default: unbounded
   * (callers with a fixed key set).
   */
  constructor(options: { ttlMs?: number; staleWhileRevalidateMs?: number; now?: () => number; schedule?: Schedule; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 0
    this.staleWhileRevalidateMs = options.staleWhileRevalidateMs ?? 0
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((task) => setImmediate(task))
    this.maxEntries = options.maxEntries !== undefined && options.maxEntries > 0 ? Math.floor(options.maxEntries) : Number.POSITIVE_INFINITY
  }

  /** Cached entries (expired ones included until they are evicted or read again). */
  get size(): number {
    return this.cache.size
  }

  private store(key: string, entry: Entry<T>) {
    // re-insert so Map order is write order: the first key is the least recently written
    this.cache.delete(key)
    this.cache.set(key, entry)
    if (this.cache.size <= this.maxEntries) return
    const now = this.now()
    for (const [cachedKey, cached] of this.cache) if (cached.staleUntil <= now) this.cache.delete(cachedKey)
    for (const cachedKey of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break
      this.cache.delete(cachedKey)
    }
  }

  private load(key: string, loader: () => Promise<T> | T, deferred = false): Promise<T> {
    const current = this.inflight.get(key)
    if (current) return current

    const revision = this.revision
    const execute = async () => {
      const value = await loader()
      if (this.ttlMs > 0 && revision === this.revision) {
        const expiresAt = this.now() + this.ttlMs
        this.store(key, { value, expiresAt, staleUntil: expiresAt + this.staleWhileRevalidateMs })
      }
      return value
    }
    const pending = deferred
      ? new Promise<T>((resolve, reject) => this.schedule(() => { void execute().then(resolve, reject) }))
      : execute()
    this.inflight.set(key, pending)
    void pending.finally(() => this.inflight.delete(key)).catch(() => undefined)
    return pending
  }

  run(key: string, loader: () => Promise<T> | T): Promise<T> {
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value)
    if (cached && cached.staleUntil > this.now()) {
      // Schedule the refresh after the current request can write its response.
      // The previous value remains usable if the refresh fails.
      if (!this.inflight.has(key)) void this.load(key, loader, true).catch(() => undefined)
      return Promise.resolve(cached.value)
    }
    if (cached) this.cache.delete(key)
    return this.load(key, loader)
  }

  clear(key?: string): void {
    this.revision += 1
    if (key === undefined) this.cache.clear()
    else this.cache.delete(key)
  }
}
