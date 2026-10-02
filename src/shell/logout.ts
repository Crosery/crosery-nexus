import { useRouter } from 'vue-router'
import { api } from '../api'
import { clearSession } from '../app/session'
import { errorMessage } from '../lib/errors'
import { notify } from '../ui/feedback/toast'

/** Sign out on the server first (it revokes the token); the local state only clears once that succeeded. */
export function useLogout() {
  const router = useRouter()
  let busy = false
  return async function logout() {
    if (busy) return
    busy = true
    try {
      await api.logout()
      clearSession()
      await router.replace({ name: 'login' })
    } catch (error) {
      notify(`◆ 退出失败 · ${errorMessage(error) || '连不上服务器'}`, { tone: 'bad', id: 'cx-logout' })
    } finally {
      busy = false
    }
  }
}
