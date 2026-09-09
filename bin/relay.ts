#!/usr/bin/env node

import { main } from '../src/cli.js'

if (process.versions.bun) {
  process.stderr.write('relay requires Node.js for its native storage dependencies. Use bun run relay <command> to launch it through Bun tooling.\n')
  process.exitCode = 1
} else {
  main().catch((error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
