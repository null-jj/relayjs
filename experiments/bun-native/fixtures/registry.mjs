// Bypass the CLI's deliberate Bun guard only inside the isolated experiment.
import { initRegistry } from './dist/src/infrastructure/registry.js'
const registry = await initRegistry(process.argv[2])
try {
  console.log(JSON.stringify({ registryKey: registry.key }))
} finally {
  await registry.close()
}
