#!/usr/bin/env node
// `npm create rabolic` / `pnpm create rabolic`: the same as `npx rabolic init`.
import { run, terminalIo } from 'rabolic'

process.exitCode = await run(['init', ...process.argv.slice(2)], terminalIo())
