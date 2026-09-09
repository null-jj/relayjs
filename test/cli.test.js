import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { run } from '../dist/src/cli.js'

const execFileAsync = promisify(execFile)
const cli = join(process.cwd(), 'dist', 'bin', 'relay.js')

async function invoke(args, env = {}) {
  try {
    return await execFileAsync(process.execPath, [cli, ...args], { timeout: 5_000, env: { ...process.env, ...env } })
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code }
  }
}

test('shows help without opening a registry', async () => {
  const result = await invoke(['--help'])

  assert.match(result.stdout, /Usage: relay <command>/)
  assert.match(result.stdout, /publish FILE --name NAME --version VERSION/)
  assert.equal(result.stderr, '')
})

test('rejects unknown commands and invalid options', async () => {
  const unknown = await invoke(['missing'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /Unknown command: missing/)

  const invalidTimeout = await invoke(['init', '--timeout', '0'])
  assert.equal(invalidTimeout.code, 1)
  assert.match(invalidTimeout.stderr, /--timeout must be a positive integer/)
})

test('initializes a registry and prints usable identifiers', async (t) => {
  const store = await mkdtemp(join(tmpdir(), 'relayjs-cli-'))
  t.after(() => rm(store, { recursive: true, force: true }))

  const result = await invoke(['init', '--store', store])
  assert.equal(result.stderr, '')
  const identity = JSON.parse(result.stdout)
  assert.match(identity.registryKey, /^[a-f0-9]{64}$/)
  assert.match(identity.identity, /^[a-f0-9]{64}$/)
  assert.equal(identity.store, store)
})

function outputBuffer() {
  return {
    value: '',
    write(chunk) { this.value += chunk },
  }
}

test('fetch waits for an aborted file operation to settle before returning a timeout', async () => {
  const signals = new EventEmitter()
  const output = outputBuffer()
  let settled = false
  let closed = false
  const registry = {
    connect() {},
    async close() { closed = true },
  }

  await assert.rejects(
    run(['fetch', 'thing@1', '--output', '/tmp/result', '--timeout', '1'], {
      stdout: output,
      signalSource: signals,
      openRegistry: async () => registry,
      createFileAccess: () => ({}),
      fetchArtifact: async (_ports, request) => new Promise((resolve) => {
        request.signal.addEventListener('abort', () => {
          setTimeout(() => {
            settled = true
            resolve()
          }, 5)
        }, { once: true })
      }),
    }),
    /Fetch timed out after 1ms/,
  )
  assert.equal(closed, true)
  assert.equal(settled, true)
  assert.equal(output.value, '')
})

test('list timeout covers synchronization and does not call list afterward', async () => {
  const signals = new EventEmitter()
  let resolveSync
  let listCalls = 0
  const registry = {
    connect() {},
    sync: () => new Promise((resolve) => { resolveSync = resolve }),
    async close() { resolveSync() },
  }

  await assert.rejects(
    run(['list', '--timeout', '1'], {
      signalSource: signals,
      openRegistry: async () => registry,
      listArtifacts: async () => { listCalls += 1; return [] },
    }),
    /List timed out after 1ms/,
  )
  assert.equal(listCalls, 0)
})

test('list timeout waits for list cleanup before returning without output', async () => {
  const signals = new EventEmitter()
  const output = outputBuffer()
  let settleList
  let settled = false
  const registry = {
    connect() {},
    async sync() {},
    async close() {
      setTimeout(() => {
        settled = true
        settleList()
      }, 5)
    },
  }

  await assert.rejects(
    run(['list', '--timeout', '20'], {
      stdout: output,
      signalSource: signals,
      openRegistry: async () => registry,
      listArtifacts: async () => new Promise((resolve) => { settleList = () => resolve([]) }),
    }),
    /List timed out after 20ms/,
  )
  assert.equal(settled, true)
  assert.equal(output.value, '')
})

test('SIGINT aborts an active fetch and waits for cleanup', async () => {
  const signals = new EventEmitter()
  const output = outputBuffer()
  let settled = false
  let closed = false
  const registry = {
    connect() {},
    async close() { closed = true },
  }
  const pending = run(['fetch', 'thing@1', '--output', '/tmp/result'], {
    stdout: output,
    signalSource: signals,
    openRegistry: async () => registry,
    createFileAccess: () => ({}),
    fetchArtifact: async (_ports, request) => new Promise((resolve) => {
      request.signal.addEventListener('abort', () => {
        setTimeout(() => {
          settled = true
          resolve()
        }, 5)
      }, { once: true })
    }),
  })

  await new Promise((resolve) => setImmediate(resolve))
  signals.emit('SIGINT')
  await assert.rejects(pending, /Operation cancelled by SIGINT/)
  assert.equal(closed, true)
  assert.equal(settled, true)
  assert.equal(output.value, '')
})

test('seed mirrors an already cached artifact without synchronizing first', async () => {
  const signals = new EventEmitter()
  const output = outputBuffer()
  let syncCalls = 0
  let closed = false
  const registry = {
    identity: 'a'.repeat(64),
    connect() {},
    async sync() { syncCalls += 1 },
    async close() { closed = true },
  }
  const pending = run(['seed', 'thing@1'], {
    stdout: output,
    signalSource: signals,
    openRegistry: async () => registry,
    createFileAccess: () => ({}),
    mirrorArtifact: async () => ({ name: 'thing', version: '1' }),
  })

  await new Promise((resolve) => setImmediate(resolve))
  signals.emit('SIGINT')
  await pending
  assert.equal(syncCalls, 0)
  assert.equal(closed, true)
  assert.match(output.value, /"name":"thing"/)
})


test('seed without a registry explains setup and does not create registry data', async t => {
  const store = await mkdtemp(join(tmpdir(), 'relayjs-missing-registry-'))
  t.after(() => rm(store, { recursive: true, force: true }))
  const result = await invoke(['seed', 'app@1.0', '--store', store])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /No registry initialized/)
  assert.match(result.stderr, /bun run relay init/)
  assert.match(result.stderr, /bun run relay join REGISTRY_KEY/)
  assert.match(result.stderr, /--store/)
  assert.doesNotMatch(result.stderr, /ENOENT/)
  assert.equal(result.stdout, '')
  assert.deepEqual(await readdir(store), [])
})


test('development store environment is isolated and explicit store wins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relayjs-environments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const development = join(directory, 'development')
  const home = join(directory, 'home')
  const env = { RELAY_STORE: development, HOME: home }
  const initialized = JSON.parse((await invoke(['init'], env)).stdout)
  assert.equal(initialized.store, development)
  const identity = JSON.parse((await invoke(['identity'], env)).stdout)
  assert.equal(identity.registryKey, initialized.registryKey)
  await assert.rejects(readdir(join(home, '.pear-artifact')), { code: 'ENOENT' })

  const explicit = join(directory, 'explicit')
  const override = JSON.parse((await invoke(['init', '--store', explicit], env)).stdout)
  assert.equal(override.store, explicit)
  assert.notEqual(override.registryKey, initialized.registryKey)

  const production = JSON.parse((await invoke(['init'], { ...env, RELAY_STORE: '' })).stdout)
  assert.equal(production.store, join(home, '.pear-artifact'))
  assert.notEqual(production.registryKey, initialized.registryKey)
})
