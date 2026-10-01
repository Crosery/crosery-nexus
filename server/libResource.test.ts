import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { useResource } from '../src/lib/resource.js'

/**
 * 行为级测试（红队第四轮 R4-B 的整改）：
 * 之前 `server/reportPageFrontend.test.ts` 只对 `src/lib/resource.ts` 做**源码文本正则**，
 * 把守卫在语义上打瘫（在守卫之前插一行 `data.value = result`，保留所有被断言的文本）后，
 * 那套断言照样全绿。这里改成真的跑状态机：用受控 Promise 造乱序、失败、销毁三种时序，
 * 断言**可观察行为**而不是源码长什么样。
 *
 * 不需要 DOM：`effectScope()` 提供 `onScopeDispose` 所需的活跃作用域，`watch`/`ref`/`nextTick` 在组件外可用。
 */

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让已排队的 watch 回调与 Promise 回调都跑完。 */
const flush = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

test('useResource：依赖变化触发重取，迟到的旧响应被丢弃（先发慢、后发快）', async () => {
  const scope = effectScope()
  const dep = ref(0)
  const gates: Array<Deferred<string>> = []
  const resource = scope.run(() =>
    useResource<string>(() => {
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    }, [dep]),
  )!

  await flush()
  assert.equal(gates.length, 1, '首次加载（immediate）应发一次请求')
  assert.equal(resource.loading.value, true, '请求在飞行中应为 loading')

  // 第二次请求：依赖变化触发
  dep.value = 1
  await flush()
  assert.equal(gates.length, 2, '依赖变化应触发重取')

  // 后发的先回（快），先发的后回（慢）
  gates[1].resolve('second')
  await flush()
  assert.equal(resource.data.value, 'second', '后发请求的结果应写入')

  gates[0].resolve('first')
  await flush()
  assert.equal(resource.data.value, 'second', '迟到的旧响应不得覆盖新结果')
  assert.equal(resource.loading.value, false, '全部结束后 loading 应为 false')
  scope.stop()
})

test('useResource：刷新失败保留旧数据，同时暴露 error', async () => {
  const scope = effectScope()
  const gates: Array<Deferred<string>> = []
  const resource = scope.run(() =>
    useResource<string>(() => {
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    }, []),
  )!

  await flush()
  gates[0].resolve('cached')
  await flush()
  assert.equal(resource.data.value, 'cached')
  assert.equal(resource.error.value, null)

  // 第二次读取失败
  void resource.reload()
  await flush()
  assert.equal(resource.loading.value, true)
  gates[1].reject(new Error('boom'))
  await flush()

  assert.equal(resource.data.value, 'cached', '失败时旧数据必须保留（页面不闪空、不清空）')
  const failure: unknown = resource.error.value
  assert.ok(failure instanceof Error, 'error 应被设置为失败原因')
  assert.equal(failure.message, 'boom')
  assert.equal(resource.loading.value, false)
  assert.equal(resource.initial.value, false, '已经有数据后 initial 不应回到 true')
  scope.stop()
})

test('useResource：作用域销毁后不再写入（onScopeDispose 语义）', async () => {
  const scope = effectScope()
  const gate = deferred<string>()
  const resource = scope.run(() => useResource<string>(() => gate.promise, []))!

  await flush()
  assert.equal(resource.loading.value, true)

  scope.stop()
  gate.resolve('late')
  await flush()

  assert.equal(resource.data.value, undefined, '销毁后返回的响应不得写入 data')
  assert.equal(resource.error.value, null, '销毁后也不得写入 error')
})

test('useResource：旧请求失败不得覆盖新请求的成功结果', async () => {
  const scope = effectScope()
  const dep = ref(0)
  const gates: Array<Deferred<string>> = []
  const resource = scope.run(() =>
    useResource<string>(() => {
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    }, [dep]),
  )!

  await flush()
  dep.value = 1
  await flush()

  gates[1].resolve('fresh')
  await flush()
  gates[0].reject(new Error('stale failure'))
  await flush()

  assert.equal(resource.data.value, 'fresh')
  assert.equal(resource.error.value, null, '过期请求的失败不应污染当前错误态')
  scope.stop()
})

test('useResource：enabled() 为 false 时不发请求', async () => {
  const scope = effectScope()
  let calls = 0
  const enabled = ref(false)
  const resource = scope.run(() =>
    useResource<string>(() => {
      calls += 1
      return Promise.resolve('x')
    }, [], { enabled: () => enabled.value }),
  )!

  await flush()
  assert.equal(calls, 0, 'enabled() 为 false 时不应调用 fetcher')

  enabled.value = true
  await resource.reload()
  await flush()
  assert.equal(calls, 1)
  assert.equal(resource.data.value, 'x')
  scope.stop()
})
