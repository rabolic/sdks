// CDN entry (dist/rabolic.global.js): exposes window.rabolic.
import { installGlobal } from './install-global'

if (typeof window !== 'undefined') installGlobal(window)
