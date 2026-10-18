/**
 * DESIGN.md §5.2 composables that live in src/lib (they are app-wide state, also used outside src/ui):
 * useThemeWipe = useThemePref().toggle(originEvent) draws the circular wipe from the pressed control.
 */
export { useThemePref, useThemePref as useThemeWipe, setThemePref, toggleTheme } from '../../lib/theme'
export { useSkinPref, setSkinPref, parseSkinPref } from '../../lib/skin'
export type { SkinPref } from '../../lib/skin'
export type { ThemePref, ThemeName } from '../../lib/theme'
export { useMotionPref, setMotionPref, isReducedMotion } from '../../lib/motion'
export type { MotionPref } from '../../lib/motion'
export { useTitlePref, setTitlePref, resetTitlePref, parseTitlePref, DEFAULT_TITLE } from '../../lib/title'
export { useMask, setMask, toggleMask, maskEmail, maskName, maskPii } from '../../lib/privacy'
