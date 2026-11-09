#!/usr/bin/env node
import { run, terminalIo } from './run'

process.exitCode = await run(process.argv.slice(2), terminalIo())
