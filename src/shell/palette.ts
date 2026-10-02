/**
 * Page → ⌘K registry. A mounted page adds its FIND / ACT commands (accounts by email, keys by name, models by
 * id — from indexes it already loaded) and they disappear when it unmounts. The shell merges them with the
 * page jumps and its own actions.
 */
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import type { CommandItem } from '../ui/types'

const sources = shallowRef<Array<{ id: number; get: () => CommandItem[] }>>([])
let nextId = 1

export const registeredCommands = computed<CommandItem[]>(() => sources.value.flatMap((source) => source.get()))

/** Call in a page's setup; `get` is re-read whenever its reactive inputs change. */
export function usePaletteCommands(get: () => CommandItem[]) {
  const id = nextId++
  sources.value = [...sources.value, { id, get }]
  onBeforeUnmount(() => {
    sources.value = sources.value.filter((source) => source.id !== id)
  })
}
