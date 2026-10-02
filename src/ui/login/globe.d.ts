export type GlobeReadouts = { rot?: HTMLElement | null; tilt?: HTMLElement | null; frame?: HTMLElement | null; lat?: HTMLElement | null; n?: HTMLElement | null }

export type GlobeHandle = {
  /** sign-in exit (spin-up + scale + fade, 520ms; 120ms fade under reduced motion); resolve, then navigate */
  exit(ms?: number): Promise<void>
  destroy(): void
}

/** Sphere centre and radius for a viewport and the plate's client rect (pure; see globe.js). */
export function sphereTarget(W: number, H: number, plate: { left: number; top: number }): { x: number; y: number; r: number }

export function isStacked(W: number, H: number): boolean
export function glyphBudget(r: number, compact: boolean): number

export function createGlobe(el: {
  back: HTMLCanvasElement
  front: HTMLCanvasElement
  plate: HTMLElement
  wrap: HTMLElement
  readouts?: GlobeReadouts
}): GlobeHandle
