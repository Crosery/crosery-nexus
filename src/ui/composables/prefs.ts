/**
 * DESIGN.md §5.2 composables that live in src/lib (they are app-wide state, also used outside src/ui):
 * useThemeWipe = useThemePref().toggle(originEvent) draws the circular wipe from the pressed control.
 */
export { useThemePref, useThemePref as useThemeWipe, setThemePref, toggleTheme } from '../../lib/theme'
export type { ThemePref, ThemeName } from '../../lib/theme'
export { useMotionPref, setMotionPref, isReducedMotion } from '../../lib/motion'
export type { MotionPref } from '../../lib/motion'
export { useMask, setMask, toggleMask, maskEmail, maskName, maskPii } from '../../lib/privacy'
