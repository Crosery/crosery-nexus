<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxForm, TxFormItem } from '@talex-touch/tuffex/form'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { TxSwitch } from '@talex-touch/tuffex/switch'
import { TxStack } from '@talex-touch/tuffex/stack'
import Plate from '../../ui/data/Plate.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Switch from '../../ui/form/Switch.vue'
import { useMask, useMotionPref, useSkinPref, useThemePref, useTitlePref, type MotionPref, type SkinPref, type ThemePref } from '../../ui/composables/prefs'
import { useSingleKeyPref } from '../../ui/composables/useShortcuts'
import ConsoleTitleEditor from '../../ui/shell/ConsoleTitleEditor.vue'

/**
 * 偏好 (#prefs, DESIGN §6.8 外观 + 隐私): theme, skin, motion, the WCAG 2.1.4 single-key shortcut switch
 * and the privacy mask. Everything is per device (localStorage), nothing is sent.
 */
const theme = useThemePref()
const skin = useSkinPref()
const motion = useMotionPref()
const keys = useSingleKeyPref()
const mask = useMask()
const titlePref = useTitlePref()
const titleEditorOpen = ref(false)
function openTitleEditor() {
  titleEditorOpen.value = true
}

const THEMES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]
const SKINS = [
  { value: 'telemetry', label: 'Telemetry' },
  { value: 'minimal', label: '简约' },
]
const MOTIONS = [
  { value: 'full', label: '完整' },
  { value: 'reduce', label: '减弱' },
  { value: 'system', label: '跟随系统' },
]
const themeHost = useTemplateRef<HTMLElement>('themeHost')
function setTheme(value: string | number | null | undefined) {
  if (typeof value !== 'string') return
  // the wipe grows from the pressed segment (keyboard or pointer), else from the control
  const focused = document.activeElement
  const origin = focused && themeHost.value?.contains(focused) ? focused : themeHost.value
  theme.set(value as ThemePref, origin ?? undefined)
}
function setMotion(value: string | number | null | undefined) {
  if (typeof value === 'string') motion.set(value as MotionPref)
}
const motionNote = computed(() => (motion.reduced.value ? '当前减弱 · 不播放扫描线和滚动数字' : '当前完整'))
</script>

<template>
  <Plate id="prefs" title="偏好" class="set-sec" :print="true">
    <template #meta><span>只存在这台设备</span></template>
    <TxForm v-if="skin.pref.value === 'minimal'" label-position="top" class="set-prefs-form">
      <TxFormItem label="皮肤" class="set-prefs-form__item">
        <TxFilterChips :model-value="skin.pref.value" :items="SKINS" aria-label="皮肤" @update:model-value="skin.set($event as SkinPref)" />
      </TxFormItem>
      <TxFormItem label="主题" class="set-prefs-form__item">
        <TxFilterChips :model-value="theme.pref.value" :items="THEMES" aria-label="主题" @update:model-value="setTheme" />
      </TxFormItem>
      <TxFormItem label="单键快捷键" class="set-prefs-form__item">
        <TxStack>
          <TxSwitch :model-value="keys.on.value" aria-label="单键快捷键" @update:model-value="keys.set" />
          <small>T 主题 · M 脱敏 · 1–8 跳转</small>
        </TxStack>
      </TxFormItem>
      <TxFormItem label="动效" class="set-prefs-form__item">
        <TxStack>
          <TxFilterChips :model-value="motion.pref.value" :items="MOTIONS" aria-label="动效" @update:model-value="setMotion" />
          <small>{{ motionNote }}</small>
        </TxStack>
      </TxFormItem>
      <TxFormItem label="邮箱脱敏" class="set-prefs-form__item">
        <TxStack>
          <TxSwitch :model-value="mask.on.value" aria-label="邮箱脱敏" @update:model-value="mask.set" />
          <small>只影响当前设备的显示</small>
        </TxStack>
      </TxFormItem>
      <TxFormItem label="控制台标题" class="set-prefs-form__item">
        <TxStack>
          <TxButton size="sm" variant="secondary" @click="openTitleEditor">编辑</TxButton>
          <small style="color: var(--tx-text-color-secondary)">当前：{{ titlePref.pref.value }} · 默认 Crosery</small>
        </TxStack>
      </TxFormItem>
      <TxFormItem label="API Key 明文" class="set-prefs-form__item set-prefs-form__item--wide">
        <span style="font-size: 13px; color: var(--tx-text-color-secondary)">列表只显示尾号 · 新建后或确认后才显示完整 Key</span>
      </TxFormItem>
    </TxForm>
    <div v-else class="set-prefs">
      <div class="set-pref">
        <span class="set-pref__k">主题</span>
        <span ref="themeHost" class="set-pref__v">
          <Segmented :model-value="theme.pref.value" :items="THEMES" label="主题" @update:model-value="setTheme" />
        </span>
      </div>
      <div class="set-pref">
        <span class="set-pref__k">皮肤<small>简约只使用 Tuffex 原生组件样式</small></span>
        <span class="set-pref__v">
          <Segmented :model-value="skin.pref.value" :items="SKINS" label="皮肤" @update:model-value="skin.set($event as SkinPref)" />
        </span>
      </div>
      <div class="set-pref">
        <span class="set-pref__k">单键快捷键<small>T 主题 · M 脱敏 · 1–8 跳转</small></span>
        <span class="set-pref__v">
          <Switch :model-value="keys.on.value" aria-label="单键快捷键" @update:model-value="keys.set" />
        </span>
      </div>
      <div class="set-pref">
        <span class="set-pref__k">动效<small>{{ motionNote }}</small></span>
        <span class="set-pref__v">
          <Segmented :model-value="motion.pref.value" :items="MOTIONS" label="动效" @update:model-value="setMotion" />
        </span>
      </div>
      <div class="set-pref">
        <span class="set-pref__k">邮箱脱敏<small>截图前打开 · 只影响显示</small></span>
        <span class="set-pref__v">
          <Switch :model-value="mask.on.value" aria-label="邮箱脱敏" @update:model-value="mask.set" />
        </span>
      </div>
      <div class="set-pref set-pref--wide">
        <span class="set-pref__k">API Key 明文</span>
        <span class="set-pref__v dim">列表只显示尾号 · 新建后或确认后才显示完整 Key</span>
      </div>
    </div>
  </Plate>
  <ConsoleTitleEditor v-if="skin.pref.value === 'minimal'" v-model="titleEditorOpen" />
</template>

<style>
/* rows separated by spacing alone (no hairline per row) */
.set-prefs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 40px; padding-bottom: 2px; }
.set-pref { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; min-width: 0; }
.set-pref--wide { grid-column: 1 / -1; min-height: 36px; }
.set-pref__k { display: grid; gap: 1px; font-size: var(--fs-base); color: var(--ink); min-width: 0; }
.set-pref__k small { font-size: var(--fs-xs); color: var(--ink-3); }
.set-pref__v { display: flex; align-items: center; justify-content: flex-end; min-width: 0; font-size: var(--fs-sm); text-align: right; }
.set-pref--wide .set-pref__v { font-size: var(--fs-xs); }
@media (max-width: 959px) {
  .set-prefs { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 599px) {
  .set-pref { flex-wrap: wrap; row-gap: 6px; padding: 4px 0; }
  .set-pref__v { flex: 1 0 auto; }
  .set-pref--wide .set-pref__v { flex-basis: 100%; justify-content: flex-start; text-align: left; }
}
</style>
