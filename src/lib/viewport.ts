/**
 * 视口断点：只在需要「真的少渲染一份」时使用（例如移动端与桌面端共用一个 VersionWidget，
 * 用 CSS `display:none` 藏起来的那份照样会挂载、照样会发请求）。
 * 对照参考实现 `geek_main/app/console/src/components/ConsoleShell.vue:15-22` 的桌面/移动外壳切换。
 */
import { onScopeDispose, ref, type Ref } from 'vue'

export const MOBILE_QUERY = '(max-width: 900px)'

export function useMediaQuery(query: string = MOBILE_QUERY): Ref<boolean> {
  const matches = ref(false)
  if (typeof window === 'undefined' || !window.matchMedia) return matches
  const list = window.matchMedia(query)
  matches.value = list.matches
  const onChange = (event: MediaQueryListEvent) => {
    matches.value = event.matches
  }
  list.addEventListener('change', onChange)
  onScopeDispose(() => list.removeEventListener('change', onChange))
  return matches
}
