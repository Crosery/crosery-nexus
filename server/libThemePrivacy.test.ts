import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseThemePref, resolveTheme, THEME_PAPER, THEME_STORAGE_KEY, wipeRadius } from '../src/lib/theme.js'
import { detectCapture, MOTION_STORAGE_KEY, parseMotionPref, resolveMotion } from '../src/lib/motion.js'
import { MASK_STORAGE_KEY, maskEmail, maskName, maskPii } from '../src/lib/privacy.js'

/*
 * Console v3 preferences: theme (light / dark / system), motion (full / reduce / system), privacy mask.
 * The DOM side (html[data-theme|data-motion|data-mask]) is exercised in the browser; these are the rules.
 */

const REPO = path.resolve(import.meta.dirname, '..')

test('theme: system follows the OS, an explicit choice wins, junk falls back to system', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(parseThemePref('sepia'), 'system')
  assert.equal(parseThemePref(null), 'system')
  assert.equal(parseThemePref('dark'), 'dark')
})

test('theme: the wipe circle reaches the farthest viewport corner', () => {
  assert.equal(wipeRadius(0, 0, 3, 4), 5)
  assert.equal(wipeRadius(1380, 26, 1440, 900), Math.hypot(1380, 874))
})

test('theme: paper colours match tokens.css (browser chrome / theme-color)', () => {
  const tokens = fs.readFileSync(path.join(REPO, 'src/styles/tokens.css'), 'utf8')
  assert.match(tokens, new RegExp(`--paper: ${THEME_PAPER.light}`, 'i'))
  assert.match(tokens, new RegExp(`--paper: ${THEME_PAPER.dark}`, 'i'))
})

test('index.html: boot script uses the same storage key and the file stays under 1 KB', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')
  assert.ok(html.includes(`localStorage['${THEME_STORAGE_KEY}']`), 'boot script must read the theme key')
  assert.match(html, /viewport-fit=cover/)
  // the built index.html adds ~460 bytes of asset tags; staticCompression.test expects it under 1 KB
  assert.ok(Buffer.byteLength(html) < 640, `index.html source is ${Buffer.byteLength(html)} bytes`)
})

test('motion: one switch — explicit choice wins, system follows prefers-reduced-motion', () => {
  assert.equal(resolveMotion('system', true), 'reduce')
  assert.equal(resolveMotion('system', false), 'full')
  assert.equal(resolveMotion('full', true), 'full')
  assert.equal(resolveMotion('reduce', false), 'reduce')
  assert.equal(parseMotionPref('reduced'), 'system')
  assert.equal(MOTION_STORAGE_KEY, 'cx-motion')
})

test('motion: capture mode for ?capture=1 and headless Chrome', () => {
  assert.equal(detectCapture('?capture=1', 'Mozilla/5.0'), true)
  assert.equal(detectCapture('?a=b&capture=1', 'Mozilla/5.0'), true)
  assert.equal(detectCapture('?capture=10', 'Mozilla/5.0'), false)
  assert.equal(detectCapture('', 'Mozilla/5.0 HeadlessChrome/131.0'), true)
  assert.equal(detectCapture('', 'Mozilla/5.0 Chrome/131.0'), false)
})

test('privacy: emails keep 2 + last char of the local part, the domain is hidden', () => {
  assert.equal(maskEmail('zhang.wei@example.com'), 'zh••••••i@•••')
  assert.equal(maskEmail('zhangg@example.com'), 'zh•••g@•••')
  assert.equal(maskEmail('abc@example.com'), 'a••@•••')
  assert.equal(maskEmail('plainname'), 'pl••••••e')
  assert.equal(maskName('张三'), '张•')
  assert.equal(maskName('growth-team-batch'), 'g••••••h')
  assert.equal(maskPii('ops@example.com'), 'o••@•••')
  assert.equal(maskPii('张伟', 'name'), '张•')
  assert.equal(MASK_STORAGE_KEY, 'cx-mask')
})
