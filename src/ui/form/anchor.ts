/**
 * Calm panel props for every tuffex component that floats a panel (TxSelect, TxDropdownMenu, TxPopover via
 * v-bind; TxTooltip via `:anchor`). tuffex defaults to a refraction surface, an SVG outline over the card
 * border, an 18px radius and a springy blur-expand: that is the rainbow, box-in-box dropdown. These props ask
 * for one solid sheet; styles/tx/base-anchor.css enforces the same look for direct page usage that forgets them.
 */
const CALM_ANIMATION = { type: 'opacity', duration: 120, closeDuration: 90 } as const

export const CALM_PANEL = {
  panelBackground: 'pure',
  panelVariant: 'solid',
  panelShadow: 'none',
  panelRadius: 2,
  panelPadding: 0,
  animation: CALM_ANIMATION,
} as const

/** dropdown / popover (TxPopover's showArrow defaults to true) */
export const CALM_MENU = { ...CALM_PANEL, panelPadding: 4, showArrow: false } as const

/** TxTooltip `:anchor` */
export const CALM_TIP = { ...CALM_PANEL, panelPadding: 6, showArrow: false, animation: { type: 'opacity', duration: 100, closeDuration: 80 } } as const
