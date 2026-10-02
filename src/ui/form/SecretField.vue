<script setup lang="ts">
import { ref, useId, useTemplateRef } from 'vue'
import { TxInput } from '@talex-touch/tuffex/input'
import Icon from '../Icon.vue'

/**
 * Secret field (DESIGN.md §5.2 form, §6.1): an API key or password typed into a masked `<input type="password">`
 * (TxInput) with an eye toggle. Unlike TxSensitiveInput it never shows the value while typing; it is revealed
 * only while the toggle is pressed. Being a native password input, password managers fill and save it (pass
 * `name` / `autocomplete`) and Enter submits the surrounding form. `invalid` + `describedby` wire the inline
 * error line (aria-invalid / aria-describedby). Call `mask()` before navigating away (e.g. on submit).
 */
const props = withDefaults(
  defineProps<{
    /** input id, for an external <label for> */
    id?: string
    name?: string
    autocomplete?: string
    placeholder?: string
    /** accessible name when there is no <label for> */
    label?: string
    /** what the toggle reveals: 显示‹noun› */
    noun?: string
    invalid?: boolean
    /** id(s) of the hint / error element */
    describedby?: string
    disabled?: boolean
    /** mono value (keys); passwords stay sans */
    mono?: boolean
  }>(),
  {
    id: undefined, name: undefined, autocomplete: 'current-password', placeholder: '', label: undefined, noun: '内容',
    invalid: false, describedby: undefined, disabled: false, mono: false,
  },
)
const model = defineModel<string>({ default: '' })
const revealed = ref(false)
const fallbackId = useId()
const inputId = () => props.id ?? fallbackId
const field = useTemplateRef<InstanceType<typeof TxInput>>('field')

function toggle() {
  revealed.value = !revealed.value
}
function mask() {
  revealed.value = false
}
function focus() {
  field.value?.focus()
}
defineExpose({ focus, mask })
</script>

<template>
  <TxInput
    :id="inputId()"
    ref="field"
    v-model="model"
    class="ui-secret"
    :class="{ 'is-err': invalid, 'is-mono': mono }"
    :type="revealed ? 'text' : 'password'"
    :name="name"
    :autocomplete="autocomplete"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="label"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedby"
    spellcheck="false"
    autocapitalize="off"
    autocorrect="off"
    caps-lock-text="大写锁定已开启"
  >
    <template #suffix>
      <button
        type="button"
        class="ui-icon-btn ui-secret__eye"
        :aria-label="`显示${noun}`"
        :aria-pressed="revealed"
        :aria-controls="inputId()"
        :title="revealed ? `隐藏${noun}` : `显示${noun}`"
        :disabled="disabled"
        @click="toggle"
      >
        <Icon :name="revealed ? 'eye-off' : 'eye'" />
      </button>
    </template>
  </TxInput>
</template>

<style>
html:root .ui-secret { padding-right: 2px; }
html:root .ui-secret.is-mono .tx-input__inner { font-family: var(--font-mono); letter-spacing: .02em; }
html:root .ui-secret.is-err { box-shadow: inset 0 -1px 0 var(--signal); }
html:root .ui-secret .tx-input__capslock { color: var(--signal-ink); }
.ui-secret__eye { margin-left: 2px; }
.ui-secret__eye[aria-pressed="true"] { color: var(--ink); }
/* the wrapper ring belongs to the text field; while the eye button has focus only the button rings */
html .tx-input:has(button:focus-visible):not(:has(input:focus-visible)) { outline: none !important; }
</style>
