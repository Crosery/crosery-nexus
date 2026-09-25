import { performance } from 'node:perf_hooks'

const baseUrl = (process.env.BENCHMARK_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const paths = (process.env.BENCHMARK_PATHS || '/api/session')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const cookie = process.env.BENCHMARK_COOKIE || ''
const samples = boundedInteger(process.env.BENCHMARK_SAMPLES, 40, 5, 10_000)
const warmups = boundedInteger(process.env.BENCHMARK_WARMUPS, 5, 0, 1_000)
const timeoutMs = boundedInteger(process.env.BENCHMARK_TIMEOUT_MS, 5_000, 100, 60_000)
const p95BudgetMs = boundedNumber(process.env.BENCHMARK_P95_MS, 0, 0, 60_000)

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function percentile(sorted, value) {
  if (!sorted.length) return 0
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)
  return sorted[index]
}

async function timedFetch(path) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  await response.arrayBuffer()
  const elapsedMs = performance.now() - started
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return elapsedMs
}

let failed = false
for (const path of paths) {
  for (let index = 0; index < warmups; index += 1) await timedFetch(path)
  const timings = []
  for (let index = 0; index < samples; index += 1) timings.push(await timedFetch(path))
  timings.sort((left, right) => left - right)
  const report = {
    path,
    samples,
    p50Ms: Number(percentile(timings, 50).toFixed(2)),
    p95Ms: Number(percentile(timings, 95).toFixed(2)),
    p99Ms: Number(percentile(timings, 99).toFixed(2)),
    maxMs: Number(timings.at(-1).toFixed(2)),
  }
  console.log(JSON.stringify(report))
  if (p95BudgetMs > 0 && report.p95Ms > p95BudgetMs) failed = true
}

if (failed) {
  console.error(`API p95 exceeded ${p95BudgetMs}ms`)
  process.exitCode = 1
}
