import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const css = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const pageMotionRule = css.match(/\.page-motion-layer\{([^}]*)\}/)?.[1] ?? ''

test('页面主容器静态可见，不能依赖进入动画恢复透明度', () => {
  assert.match(pageMotionRule, /(?:^|;)\s*opacity\s*:\s*1\s*(?:;|$)/)
  assert.match(pageMotionRule, /(?:^|;)\s*transform\s*:\s*none\s*(?:;|$)/)
  assert.doesNotMatch(pageMotionRule, /(?:^|;)\s*animation\s*:/)
})
