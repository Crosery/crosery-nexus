/**
 * Calm panel props for Telemetry Paper skin (TxSelect, TxDropdownMenu, TxPopover via
 * v-bind; TxTooltip via `:anchor`). In minimal skin, we return empty props so Tuffex uses its
 * native design tokens and components (refraction surface, smooth spring animations, native radius).
 */
import { useSkinPref as getSkinPreference } from '../../lib/skin'

const CALM_ANIMATION = { type: 'opacity', duration: 120, closeDuration: 90 } as const

export const TELEMETRY_PANEL = {
  panelBackground: 'pure',
  panelVariant: 'solid',
  panelShadow: 'none',
  panelRadius: 2,
  panelPadding: 0,
  animation: CALM_ANIMATION,
} as const

export const TELEMETRY_MENU = { ...TELEMETRY_PANEL, panelPadding: 4, showArrow: false } as const
export const TELEMETRY_TIP = { ...TELEMETRY_PANEL, panelPadding: 6, showArrow: false, animation: { type: 'opacity', duration: 100, closeDuration: 80 } } as const

type PanelProps = typeof TELEMETRY_PANEL
type MenuProps = typeof TELEMETRY_MENU
type TipProps = typeof TELEMETRY_TIP

function skinIsMinimal(): boolean {
  // Reading the shared ref also tracks skin changes during a component render.
  return getSkinPreference().pref.value === 'minimal'
}

function createSkinProxy<T extends object>(telemetryValue: T): T {
  return new Proxy(telemetryValue, {
    get(target, prop, receiver) {
      if (skinIsMinimal()) return undefined
      return Reflect.get(target, prop, receiver)
    },
    ownKeys(target) {
      return skinIsMinimal() ? [] : Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      if (skinIsMinimal()) return undefined
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
    has(target, prop) {
      if (skinIsMinimal()) return false
      return Reflect.has(target, prop)
    },
  })
}

export const CALM_PANEL: PanelProps = createSkinProxy(TELEMETRY_PANEL)
export const CALM_MENU: MenuProps = createSkinProxy(TELEMETRY_MENU)
export const CALM_TIP: TipProps = createSkinProxy(TELEMETRY_TIP)
