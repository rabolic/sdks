import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node20',
  alias: { '@rabolic/sdk-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  dts: { resolve: ['@rabolic/sdk-core'] },
  fixedExtension: false,
  sourcemap: true,
  clean: true,
})
