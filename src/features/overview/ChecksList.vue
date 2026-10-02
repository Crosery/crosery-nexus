<script setup lang="ts">
import { RouterLink } from 'vue-router'
import type { CheckRow } from './model'

/**
 * 巡检 — under the attention list, one line per domain (网关 · Key · 账号 · 渠道 · 同步 · 内核). It answers the
 * operator's four morning checks even when nothing is open, so an all-clear plate is never a blank band.
 * Marks follow the attention list: ◆ / ◇ signal (open to-dos in that domain), ○ note, ✓ clear, — unread.
 */
defineProps<{ rows: CheckRow[] }>()
const WORD: Record<CheckRow['mark'], string> = { '✓': '正常', '○': '提示', '◇': '注意', '◆': '告警', '—': '未读取' }
</script>

<template>
  <div class="ov-checks">
    <h3 class="ov-checks__h">巡检</h3>
    <ul class="ov-checks__list">
      <li v-for="(r, i) in rows" :key="r.key" class="ov-checks__row" data-row :style="{ '--r': i }">
        <RouterLink :to="r.to" class="ov-checks__link">
          <span class="ov-checks__mark" :class="{ sig: r.hot }" aria-hidden="true">{{ r.mark }}</span>
          <span class="ov-checks__kind">{{ r.kind }}</span>
          <span class="ov-checks__text">{{ r.text }}</span>
          <span class="sr-only">{{ WORD[r.mark] }}</span>
        </RouterLink>
      </li>
    </ul>
  </div>
</template>

<style>
.ov-checks { flex: 1; display: flex; flex-direction: column; padding-top: 12px; }
.ov-checks__h { margin: 0 0 2px; font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); }
.ov-checks__list { flex: 1; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
/* rows take up slack up to 44px when the gateway plate beside this one is taller; spacing separates them, no rules */
.ov-checks__row { display: flex; flex: 1 1 30px; max-height: 44px; }
.ov-checks__row > .ov-checks__link { flex: 1; }
.ov-checks__link { display: grid; grid-template-columns: 14px 32px minmax(0, 1fr); align-items: center; gap: 0 10px; min-height: 30px; color: var(--ink-2); text-decoration: none; font-size: var(--fs-xs); }
.ov-checks__link:hover .ov-checks__text { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.ov-checks__mark { font-size: 11px; line-height: 1; color: var(--ink-3); }
.ov-checks__mark.sig { color: var(--signal); }
.ov-checks__kind { color: var(--ink-3); white-space: nowrap; }
.ov-checks__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (pointer: coarse) {
  .ov-checks__link { min-height: 40px; }
}
@media (max-width: 599px) {
  .ov-checks__text { white-space: normal; padding: 4px 0; }
}
</style>
