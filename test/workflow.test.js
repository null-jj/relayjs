import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import createTestnet from '@hyperswarm/testnet'
import { initRegistry, joinRegistry, openRegistry } from '../src/infrastructure/registry.js'
import { publishArtifact } from '../src/application/artifacts.js'
import { createFileAccess } from '../src/infrastructure/files.js'
import { run } from '../src/cli.js'

test('CLI fetch uses a replica after publisher shutdown and reports unavailable peers', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-workflow-'))
  const network = await createTestnet(3)
  const registries = []
  t.after(async () => {
    await Promise.all(registries.map(registry => registry.close()))
    await network.destroy()
    await rm(directory, { recursive: true, force: true })
  })
  const publisher = await initRegistry(join(directory, 'publisher'))
  registries.push(publisher)
  const readerPath = join(directory, 'reader')
  const reader = await joinRegistry(readerPath, publisher.key)
  registries.push(reader)
  const thirdPath = join(directory, 'third')
  const third = await joinRegistry(thirdPath, publisher.key)
  registries.push(third)
  await publisher.trust(reader.identity)
  await reader.trust(publisher.identity)
  await reader.trust(third.identity)
  await third.trust(reader.identity)
  await reader.close()
  await third.close()
  const bytes = Buffer.alloc(200_000, 67)
  const source = join(directory, 'build.bin')
  await writeFile(source, bytes)
  await publishArtifact({ registry: publisher, files: createFileAccess() }, { source, name: 'build', version: '1' })
  await publisher.connect({ bootstrap: network.bootstrap })
  const bootstrap = network.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
  const capture = []
  const deps = { stdout: { write: text => capture.push(JSON.parse(text)) }, signalSource: new EventEmitter() }
  const fetch = (store, output, timeout = '8000') => run(['fetch', 'build@1', '--store', store, '--output', output, '--bootstrap', bootstrap, '--timeout', timeout], deps)
  await fetch(readerPath, join(directory, 'first.bin'))
  assert.deepEqual(await readFile(join(directory, 'first.bin')), bytes)
  await publisher.close()
  const replica = await openRegistry(readerPath)
  registries.push(replica)
  await replica.connect({ bootstrap: network.bootstrap })
  await fetch(thirdPath, join(directory, 'from-replica.bin'))
  assert.deepEqual(await readFile(join(directory, 'from-replica.bin')), bytes)
  await replica.close()
  await fetch(thirdPath, join(directory, 'offline.bin'))
  assert.deepEqual(await readFile(join(directory, 'offline.bin')), bytes)
  assert.equal(capture.length, 3)

  const unavailablePath = join(directory, 'unavailable')
  const unavailable = await joinRegistry(unavailablePath, publisher.key)
  await unavailable.close()
  await assert.rejects(fetch(unavailablePath, join(directory, 'missing.bin'), '200'), /timed out/)
  await assert.rejects(readFile(join(directory, 'missing.bin')), { code: 'ENOENT' })
})
