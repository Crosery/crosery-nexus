type Entry<T> = { value: T; expiresAt: number; staleUntil: number }

type Schedule = (task: () => void) => void

export class RequestCoordinator<T> {
  private readonly inflight = new Map<string, Promise<T>>()
  private readonly cache = new Map<string, Entry<T>>()
  private readonly ttlMs: number
  private readonly staleWhileRevalidateMs: number
  private readonly now: () => number
  private readonly schedule: Schedule
  private revision = 0

  constructor(options: { ttlMs?: number; staleWhileRevalidateMs?: number; now?: () => number; schedule?: Schedule } = {}) {
    this.ttlMs = options.ttlMs ?? 0
    this.staleWhileRevalidateMs = options.staleWhileRevalidateMs ?? 0
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((task) => setImmediate(task))
  }

  private load(key: string, loader: () => Promise<T> | T, deferred = false): Promise<T> {
    const current = this.inflight.get(key)
    if (current) return current

    const revision = this.revision
    const execute = async () => {
      const value = await loader()
      if (this.ttlMs > 0 && revision === this.revision) {
        const expiresAt = this.now() + this.ttlMs
        this.cache.set(key, { value, expiresAt, staleUntil: expiresAt + this.staleWhileRevalidateMs })
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
