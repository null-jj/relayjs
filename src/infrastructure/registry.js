import { mkdir, open, readFile, chmod, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'

const CONFIG_FILE = 'registry.json'
const STORE_DIRECTORY = 'store'
const MAX_MANIFEST_BYTES = 1024 * 1024

export async function initRegistry(directory) {
  const state = await prepareStateDirectory(directory)
  const configPath = join(state, CONFIG_FILE)
  await assertConfigAbsent(configPath)

  const identity = makeIdentity()
  let registry
  try {
    registry = await createRegistry(state, identity)
    await writeNewConfig(configPath, configFor(registry))
    return registry
  } catch (error) {
    await registry?.close().catch(() => {})
    throw error
  }
}

export async function joinRegistry(directory, registryKey) {
  const state = await prepareStateDirectory(directory)
  const key = hexKey(registryKey, 'registry key')
  const configPath = join(state, CONFIG_FILE)
  const existing = await readConfigIfPresent(configPath)

  if (existing && existing.registryKey !== key.toString('hex')) {
    throw new Error('State directory belongs to a different registry')
  }

  const identity = existing ? identityFromConfig(existing) : makeIdentity()
  let registry
  try {
    registry = await createRegistry(state, identity, key, existing?.trustedPeers)
    if (!existing) await writeNewConfig(configPath, configFor(registry))
    return registry
  } catch (error) {
    await registry?.close().catch(() => {})
    throw error
  }
}

export async function openRegistry(directory) {
  const state = await prepareStateDirectory(directory)
  const config = await readConfig(join(state, CONFIG_FILE))
  return createRegistry(state, identityFromConfig(config), hexKey(config.registryKey, 'registry key'), config.trustedPeers)
}

async function createRegistry(state, identity, key = null, trustedPeers = []) {
  const store = new Corestore(join(state, STORE_DIRECTORY))
  const drive = new Hyperdrive(store, key || undefined)

  try {
    await drive.ready()
    return new Registry({ state, store, drive, identity, trustedPeers })
  } catch (error) {
    await drive.close().catch(() => {})
    await store.close().catch(() => {})
    throw error
  }
}

class Registry {
  constructor({ state, store, drive, identity, trustedPeers }) {
    this.state = state
    this.store = store
    this.drive = drive
    this._identity = identity
    this.key = drive.key.toString('hex')
    this.identity = identity.publicKey.toString('hex')
    this.writable = drive.writable
    this._configPath = join(state, CONFIG_FILE)
    this._trusted = new Set(trustedPeers)
    this._swarm = null
    this._doneFindingPeer = null
    this._initialDiscoveryDone = false
    this._authenticatedPeer = false
    this._closed = false
  }

  async readManifest(name, version) {
    const path = manifestPath(name, version)
    const wait = Boolean(this._swarm && !this.writable)
    const entry = await this.drive.entry(path, { wait })
    if (!entry) return null
    if (entry.value.blob && entry.value.blob.byteLength > MAX_MANIFEST_BYTES) {
      throw new Error('Manifest exceeds the maximum allowed size')
    }
    const data = await this.drive.get(path, { wait })
    if (!data) return null
    if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the maximum allowed size')
    const manifest = JSON.parse(data.toString('utf8'))
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
      throw new Error('Invalid manifest')
    }
    return manifest
  }

  async writeManifest(name, version, manifest) {
    this._assertWritable()
    const path = manifestPath(name, version)
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
      throw new TypeError('Manifest must be an object')
    }
    const data = Buffer.from(JSON.stringify(manifest))
    if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the maximum allowed size')
    await this.drive.put(path, data)
  }

  async writeBlob(id, readable) {
    this._assertWritable()
    const destination = this.drive.createWriteStream(blobPath(id), { dedup: true })
    // Hyperdrive exposes streamx streams. Adapt them before handing the stream
    // to Node's pipeline; passing a streamx Writable directly to pipeline can
    // crash Node in some supported dependency combinations.
    await pipeline(readable, asNodeWritable(destination))
  }

  readBlob(id) {
    return asNodeReadable(this.drive.createReadStream(blobPath(id), { wait: true }))
  }

  async listManifests() {
    const manifests = []
    const wait = Boolean(this._swarm && !this.writable)
    for await (const entry of this.drive.list('/artifacts', { recursive: true, wait })) {
      const match = /^\/artifacts\/([^/]+)\/([^/]+)\.json$/.exec(entry.key)
      if (match) {
        const manifest = await this.readManifest(match[1], match[2])
        if (manifest) manifests.push(manifest)
      }
    }
    return manifests
  }

  async trust(peerHex) {
    const peer = hexKey(peerHex, 'peer identity').toString('hex')
    this._trusted.add(peer)
    await this._saveTrust()
    // A previous firewall rejection leaves a Hyperswarm PeerInfo banned. Make
    // an explicit trust effective immediately, including in a long-running
    // seed process, and ask the swarm to reconnect to the newly trusted peer.
    const peerInfo = this._swarm?.peers.get(peer)
    peerInfo?.ban(false)
    if (this._swarm) this._swarm.joinPeer(Buffer.from(peer, 'hex'))
  }

  async untrust(peerHex) {
    const peer = hexKey(peerHex, 'peer identity').toString('hex')
    this._trusted.delete(peer)
    await this._saveTrust()
    this._swarm?.leavePeer(Buffer.from(peer, 'hex'))
    for (const connection of this._swarm?.connections || []) {
      if (connection.remotePublicKey?.toString('hex') === peer) connection.destroy()
    }
  }

  trustedPeers() {
    return [...this._trusted].sort()
  }

  async connect({ bootstrap } = {}) {
    this._assertOpen()
    if (this._swarm) return this._swarm

    const swarm = new Hyperswarm({
      keyPair: this._identity,
      bootstrap,
      firewall: (remotePublicKey) => !this._trusted.has(remotePublicKey.toString('hex'))
    })
    swarm.on('connection', (connection) => {
      // Hyperswarm's firewall protects server connections. Repeat the allowlist
      // check here so outgoing connections cannot replicate before authorization.
      if (!this._trusted.has(connection.remotePublicKey.toString('hex'))) {
        connection.destroy()
        return
      }
      this.store.replicate(connection)
      this._authenticatedPeer = true
      this._releaseFindingPeer()
    })
    swarm.on('error', () => {})
    // Keep Hypercore's update request open until an authenticated peer is
    // available. Without this, a fresh reader can call sync before DHT
    // discovery completes and incorrectly treat an empty local cache as a
    // registry miss.
    this._doneFindingPeer = this.drive.core.findingPeers()
    swarm.join(this.drive.discoveryKey, { server: true, client: true })
    this._swarm = swarm
    swarm.flush().then(
      () => {
        this._initialDiscoveryDone = true
        this._releaseFindingPeer()
      },
      () => {
        // Keep the update pending for an authenticated peer if DHT discovery
        // fails. The caller's timeout and close() own cancellation.
      }
    )
    return swarm
  }

  async sync() {
    this._assertOpen()
    // A caller that has connected is explicitly requesting a fresh view. Let
    // Hypercore wait for the first authenticated replication peer; the CLI
    // owns the deadline and closes us to cancel that wait.
    const wait = Boolean(this._swarm)
    await this.drive.update({ wait })
    return this.drive.version
  }

  async close() {
    if (this._closed) return
    this._closed = true
    const swarm = this._swarm
    this._swarm = null
    this._doneFindingPeer?.()
    this._doneFindingPeer = null
    if (swarm) await swarm.destroy().catch(() => {})
    await this.drive.close().catch(() => {})
    await this.store.close().catch(() => {})
  }

  async _saveTrust() {
    const config = await readConfig(this._configPath)
    config.trustedPeers = this.trustedPeers()
    await writeConfig(this._configPath, config)
  }

  _assertWritable() {
    this._assertOpen()
    if (!this.writable) throw new Error('Registry is read-only')
  }

  _assertOpen() {
    if (this._closed) throw new Error('Registry is closed')
  }

  _releaseFindingPeer() {
    if (!this._initialDiscoveryDone || !this._authenticatedPeer) return
    this._doneFindingPeer?.()
    this._doneFindingPeer = null
  }
}

async function prepareStateDirectory(directory) {
  const state = resolve(directory)
  await mkdir(state, { recursive: true, mode: 0o700 })
  await chmod(state, 0o700)
  return state
}

function configFor(registry) {
  return {
    version: 1,
    registryKey: registry.key,
    identity: {
      publicKey: registry._identity.publicKey.toString('hex'),
      secretKey: registry._identity.secretKey.toString('hex')
    },
    trustedPeers: []
  }
}

function makeIdentity() {
  return crypto.keyPair()
}

function identityFromConfig(config) {
  const publicKey = hexKey(config?.identity?.publicKey, 'identity public key')
  const secretKey = Buffer.from(config?.identity?.secretKey || '', 'hex')
  if (secretKey.length !== 64) throw new Error('Invalid identity secret key in registry config')
  return { publicKey, secretKey }
}

async function assertConfigAbsent(path) {
  const config = await readConfigIfPresent(path)
  if (config) throw new Error('Registry is already initialized in this state directory')
}

async function readConfigIfPresent(path) {
  try {
    return await readConfig(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readConfig(path) {
  const data = await readFile(path, 'utf8')
  let config
  try {
    config = JSON.parse(data)
  } catch {
    throw new Error('Invalid registry config')
  }
  if (!config || config.version !== 1 || !Array.isArray(config.trustedPeers)) {
    throw new Error('Invalid registry config')
  }
  for (const peer of config.trustedPeers) hexKey(peer, 'trusted peer identity')
  return config
}

async function writeNewConfig(path, config) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8')
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
}

async function writeConfig(path, config) {
  const temporary = `${path}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

function manifestPath(name, version) {
  return `/artifacts/${pathPart(name, 'artifact name')}/${pathPart(version, 'artifact version')}.json`
}

function blobPath(id) {
  return `/blobs/${hexDigest(id)}`
}

function pathPart(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('/') || value.includes('\\') || value.includes('\0') || value === '.' || value === '..') {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}

function hexDigest(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new TypeError('Invalid blob id')
  return value.toLowerCase()
}

function hexKey(value, label) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new TypeError(`Invalid ${label}`)
  return Buffer.from(value, 'hex')
}

function asNodeWritable(stream) {
  let output
  let finished = false
  const fail = (error) => {
    if (!output.destroyed) output.destroy(error)
  }
  output = new Writable({
    write(chunk, encoding, callback) {
      if (stream.write(chunk)) return callback()
      stream.once('drain', callback)
    },
    final(callback) {
      const done = (error) => {
        stream.removeListener('finish', done)
        finished = !error
        callback(error)
      }
      stream.once('finish', done)
      stream.end()
    },
    destroy(error, callback) {
      stream.destroy(error)
      callback(error)
    }
  })
  stream.on('error', fail)
  stream.on('close', () => {
    if (!finished && !output.destroyed) fail(new Error('Hyperdrive blob stream closed before finishing'))
  })
  return output
}

function asNodeReadable(stream) {
  let ended = false
  const output = new Readable({
    read() {
      stream.resume()
    },
    destroy(error, callback) {
      stream.destroy(error)
      callback(error)
    }
  })
  stream.on('data', (chunk) => {
    if (!output.push(chunk)) stream.pause()
  })
  stream.on('end', () => {
    ended = true
    output.push(null)
  })
  stream.on('error', (error) => output.destroy(error))
  stream.on('close', () => {
    if (!ended && !output.destroyed) output.destroy(new Error('Hyperdrive blob stream closed before ending'))
  })
  return output
}
