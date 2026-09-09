import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import createTestnet from '@hyperswarm/testnet'
import { Writable as StreamxWritable } from 'streamx'

import { initRegistry, joinRegistry, openRegistry } from '../src/infrastructure/registry.js'

async function stateDirectory(t, prefix = 'pear-registry-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function link(left, right) {
  const outgoing = left.store.replicate(true)
  const incoming = right.store.replicate(false)
  outgoing.pipe(incoming).pipe(outgoing)
  return () => {
    outgoing.destroy()
    incoming.destroy()
  }
}

async function streamText(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

function within(promise, milliseconds = 5_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

async function eventually(predicate, milliseconds = 5_000) {
  const started = Date.now()
  while (Date.now() - started < milliseconds) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Condition was not met after ${milliseconds}ms`)
}

test('persists registry identity and trusted peers with restrictive config permissions', async (t) => {
  const directory = await stateDirectory(t)
  const registry = await initRegistry(directory)
  const identity = registry.identity
  const peer = 'a'.repeat(64)

  await registry.trust(peer)
  await registry.close()

  const reopened = await openRegistry(directory)
  assert.equal(reopened.identity, identity)
  assert.deepEqual(reopened.trustedPeers(), [peer])
  await reopened.untrust(peer)
  await reopened.close()

  const config = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8'))
  assert.deepEqual(config.trustedPeers, [])
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, 'registry.json'))).mode & 0o777, 0o600)
  await assert.rejects(initRegistry(directory), /already initialized/)
})

test('replicates blobs and manifests through exposed Corestore transports after the original publisher closes', async (t) => {
  const publisherDirectory = await stateDirectory(t, 'pear-publisher-')
  const replicaDirectory = await stateDirectory(t, 'pear-replica-')
  const downloaderDirectory = await stateDirectory(t, 'pear-downloader-')
  const blob = 'artifact payload '.repeat(4096)
  const digest = 'b'.repeat(64)

  const publisher = await initRegistry(publisherDirectory)
  const replica = await joinRegistry(replicaDirectory, publisher.key)
  t.after(() => publisher.close())
  t.after(() => replica.close())

  await publisher.writeBlob(digest, Readable.from([blob]))
  await publisher.writeManifest('demo', '1.0.0', { name: 'demo', version: '1.0.0', sha256: digest })

  const unlinkPublisher = link(publisher, replica)
  t.after(unlinkPublisher)
  await replica.drive.update({ wait: true })
  await replica.connect({ bootstrap: [] })
  assert.deepEqual(await replica.readManifest('demo', '1.0.0'), { name: 'demo', version: '1.0.0', sha256: digest })
  assert.equal(await streamText(replica.readBlob(digest)), blob)

  await publisher.close()
  const downloader = await joinRegistry(downloaderDirectory, replica.key)
  t.after(() => downloader.close())
  const unlinkReplica = link(replica, downloader)
  t.after(unlinkReplica)
  await downloader.drive.update({ wait: true })
  await downloader.connect({ bootstrap: [] })

  assert.deepEqual(await downloader.listManifests(), [{ name: 'demo', version: '1.0.0', sha256: digest }])
  assert.equal(await streamText(downloader.readBlob(digest)), blob)
})

test('Hyperswarm requires mutual trust before it replicates and untrust disconnects a live peer', { timeout: 15_000 }, async (t) => {
  const directory = await stateDirectory(t, 'pear-swarm-')
  const network = await createTestnet(3)
  t.after(() => network.destroy())
  const publisher = await initRegistry(join(directory, 'publisher'))
  const reader = await joinRegistry(join(directory, 'reader'), publisher.key)
  t.after(() => publisher.close())
  t.after(() => reader.close())

  await publisher.writeManifest('private', '1', { name: 'private', version: '1' })
  // Publisher's inbound firewall permits this peer, but the reader does not
  // trust the publisher. Its outbound handler must therefore destroy the
  // connection before Corestore replication starts.
  await publisher.trust(reader.identity)
  await publisher.connect({ bootstrap: network.bootstrap })
  await reader.connect({ bootstrap: network.bootstrap })
  publisher._swarm.joinPeer(Buffer.from(reader.identity, 'hex'))
  reader._swarm.joinPeer(Buffer.from(publisher.identity, 'hex'))
  await eventually(() => reader._swarm.stats.bannedPeers > 0)
  // Reader's server firewall rejected the publisher; no data reaches the
  // reader before it also grants trust.
  assert.equal(reader._swarm.peers.get(publisher.identity)?.banned, true)
  assert.equal(reader.drive.core.length, 0)

  await reader.trust(publisher.identity)
  await within(reader.sync())
  assert.deepEqual(await reader.readManifest('private', '1'), { name: 'private', version: '1' })
  assert.ok(publisher._swarm.connections.size > 0)
  assert.ok(reader._swarm.connections.size > 0)

  await reader.untrust(publisher.identity)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(reader._swarm.connections.size, 0)
  assert.equal(publisher._swarm.connections.size, 0)
  await reader.close()
  const reopened = await openRegistry(join(directory, 'reader'))
  t.after(() => reopened.close())
  assert.deepEqual(reopened.trustedPeers(), [])
})

test('Node stream adapters reject Hyperdrive write errors and premature closes', async (t) => {
  const registry = await initRegistry(await stateDirectory(t, 'pear-stream-errors-'))
  t.after(() => registry.close())
  const original = registry.drive.createWriteStream.bind(registry.drive)
  t.after(() => { registry.drive.createWriteStream = original })

  const diskFull = new Error('ENOSPC')
  registry.drive.createWriteStream = () => new StreamxWritable({
    write(data, callback) { callback(diskFull) }
  })
  await assert.rejects(
    registry.writeBlob('c'.repeat(64), Readable.from(['data'])),
    /ENOSPC/
  )

  registry.drive.createWriteStream = () => new StreamxWritable({
    write(data, callback) {
      this.destroy()
      callback(null)
    }
  })
  await assert.rejects(
    registry.writeBlob('d'.repeat(64), Readable.from(['data'])),
    /closed before finishing/
  )
})
