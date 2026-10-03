import { Worker } from 'node:worker_threads'

export type ReadOperation = {
  method: 'all' | 'get'
  sql: string
  params?: readonly (string | number | bigint | Uint8Array | null)[]
  /**
   * The worker reduces the rows itself and returns `percentileSummary(rows, fields)` (server/percentiles.mjs).
   * A reader that ignores this returns the raw rows; the caller reduces them in-process the same way.
   */
  reduce?: { percentiles: readonly string[] }
}

const MAX_PARALLEL_WORKERS = 4

type WorkerResponse = {
  id: number
  results?: unknown[]
  error?: string
}

type Pending = {
  resolve: (results: unknown[]) => void
  reject: (error: Error) => void
}

/**
 * Runs reporting queries on a separate SQLite connection so a multi-second
 * aggregation cannot freeze login, navigation, SSE heartbeats, or static files.
 */
export class SQLiteReadWorker {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly filename: string) {}

  private ensureWorker() {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./sqliteReadWorker.mjs', import.meta.url), {
      workerData: { filename: this.filename },
    })
    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.results || [])
    })
    worker.on('error', (error) => this.failWorker(worker, error))
    worker.on('exit', (code) => {
      if (code !== 0) this.failWorker(worker, new Error(`SQLite read worker exited with code ${code}`))
      else if (this.worker === worker) this.worker = null
    })
    this.worker = worker
    return worker
  }

  private failWorker(worker: Worker, error: Error) {
    if (this.worker !== worker) return
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  run(operations: readonly ReadOperation[]): Promise<unknown[]> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, operations })
    })
  }

  async close() {
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}

export class SQLiteReadPool {
  private readonly workers: SQLiteReadWorker[]
  private cursor = 0

  constructor(filename: string, size = 2) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('SQLite read pool size must be a positive integer')
    this.workers = Array.from({ length: size }, () => new SQLiteReadWorker(filename))
  }

  run(operations: readonly ReadOperation[]) {
    const worker = this.workers[this.cursor++ % this.workers.length]
    return worker.run(operations)
  }

  /**
   * Runs independent reporting operations across separate read connections.
   * Results retain the input order, but the operations do not share one SQLite
   * connection or snapshot. Callers that need ordered single-connection reads
   * must continue to use run().
   */
  async runParallel(operations: readonly ReadOperation[]): Promise<unknown[]> {
    if (!operations.length) return []

    const width = Math.min(operations.length, this.workers.length, MAX_PARALLEL_WORKERS)
    const start = this.cursor % this.workers.length
    const workers = Array.from(
      { length: width },
      (_, index) => this.workers[(start + index) % this.workers.length],
    )
    this.cursor = (start + width) % this.workers.length

    const results = new Array<unknown>(operations.length)
    let nextIndex = 0
    await Promise.all(workers.map(async (worker) => {
      while (nextIndex < operations.length) {
        const index = nextIndex++
        const [result] = await worker.run([operations[index]])
        results[index] = result
      }
    }))
    return results
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()))
  }
}
