import { fileURLToPath } from 'node:url'
import { defineConfig, presetIcons } from 'unocss'
import { tuffexIconClasses } from './scripts/tuffex-icon-classes.mjs'
import { RUNTIME_ICON_CLASSES } from './src/lib/icons'

const iconClassesScript = fileURLToPath(new URL('./scripts/tuffex-icon-classes.mjs', import.meta.url))
const runtimeIcons = fileURLToPath(new URL('./src/lib/icons.ts', import.meta.url))

export default defineConfig({
  presets: [
    presetIcons({
      scale: 1.2,
      extraProperties: {
        display: 'inline-block',
        'vertical-align': '-0.2em',
        'flex-shrink': '0',
      },
    }),
  ],

  safelist: [...new Set([...tuffexIconClasses(), ...RUNTIME_ICON_CLASSES])],

  content: {
    pipeline: {
      include: [
        /\.(vue|html|tsx|jsx)($|\?)/,
        /src\/.*\.ts($|\?)/,
      ],
    },
  },

  configDeps: [iconClassesScript, runtimeIcons],
})
