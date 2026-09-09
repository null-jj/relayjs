#!/usr/bin/env node

import { main } from '../src/cli.js'

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`)
  process.exitCode = 1
})
