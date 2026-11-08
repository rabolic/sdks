import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const alias = { '@rabolic/sdk-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) }

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'browser',
    target: 'es2022',
    alias,
    dts: { resolve: ['@rabolic/sdk-core'] },
    sourcemap: true,
    clean: false,
  },
  {
    entry: { 'rabolic.global': 'src/global.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias,
    minify: true,
    dts: false,
    clean: false,
    outputOptions: { entryFileNames: '[name].js' },
  },
])
