// Fails the build when the CDN bundle exceeds its budget: 8 KB gzip (backend-plan §14.2).
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 8 * 1024
const file = new URL('../dist/rabolic.global.js', import.meta.url)
const gzipped = gzipSync(readFileSync(file), { level: 9 }).length
console.log(`dist/rabolic.global.js: ${gzipped} bytes gzip (budget ${BUDGET_BYTES})`)
if (gzipped > BUDGET_BYTES) {
  console.error('over the size budget')
  process.exit(1)
}
