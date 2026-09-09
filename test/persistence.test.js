import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRegistry, openRegistry } from '../dist/src/infrastructure/registry.js'
import { createFileAccess } from '../dist/src/infrastructure/files.js'
import { publishArtifact, fetchArtifact, listArtifacts } from '../dist/src/application/artifacts.js'

test('published multi-block artifacts survive restart and export without a network', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-persistence-'))
  let registry
  t.after(async () => { await registry?.close(); await rm(directory, { recursive: true, force: true }) })
  registry = await initRegistry(join(directory, 'state'))
  const files = createFileAccess()
  const source = join(directory, 'build.bin')
  const bytes = Buffer.alloc(200_000, 123)
  await writeFile(source, bytes)
  const request = { source, name: 'build', version: '1' }
  const manifest = await publishArtifact({ registry, files }, request)
  await registry.close()
  registry = await openRegistry(join(directory, 'state'))
  assert.equal(registry.writable, true)
  assert.deepEqual(await listArtifacts({ registry }), [manifest])
  await assert.rejects(publishArtifact({ registry, files }, request), /already exists/)
  const destination = join(directory, 'out.bin')
  await fetchArtifact({ registry, files }, { ...request, destination })
  assert.deepEqual(await readFile(destination), bytes)
})
