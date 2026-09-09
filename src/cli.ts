import type { EventEmitter } from 'node:events'
import type { RegistryPort } from './application/ports.js'

interface CliRegistry extends RegistryPort {
  readonly key: string
  readonly identity: string
  trust(peer: string): Promise<void>
  untrust(peer: string): Promise<void>
  trustedPeers(): string[]
  connect(options: { bootstrap?: string[] }): Promise<unknown>
  close(): Promise<void>
}

type Output = { write(text: string): unknown }
type Signals = Pick<EventEmitter, 'once' | 'off'>

interface CliDependencies {
  stdout?: Output
  signalSource?: Signals
  initRegistry?: (directory: string) => Promise<CliRegistry>
  joinRegistry?: (directory: string, key: string) => Promise<CliRegistry>
  openRegistry?: (directory: string) => Promise<CliRegistry>
  createFileAccess?: typeof createFileAccess
  publishArtifact?: typeof publishArtifact
  fetchArtifact?: typeof fetchArtifact
  listArtifacts?: typeof listArtifacts
  mirrorArtifact?: typeof mirrorArtifact
}

import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import {
  fetchArtifact,
  listArtifacts,
  mirrorArtifact,
  publishArtifact,
} from './application/artifacts.js'
import { parseReference } from './domain/artifact.js'
import { createFileAccess } from './infrastructure/files.js'
import { initRegistry, joinRegistry, openRegistry } from './infrastructure/registry.js'

const HELP = `Usage: relay <command> [options]

Commands:
  init
  join REGISTRY_KEY
  identity
  trust PEER_KEY
  untrust PEER_KEY
  publish FILE --name NAME --version VERSION
  fetch NAME@VERSION --output PATH
  list
  seed [NAME@VERSION]

Options:
  --store DIR        Registry directory (default: RELAY_STORE or ~/.pear-artifact)
  --timeout MS       Network timeout in milliseconds (default: 15000)
  --bootstrap HOST:PORT  Bootstrap peer; may be repeated or comma-separated
  --help, -h         Show this help
`

class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message)
}

function parseOptions(args: string[]) {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        store: { type: 'string' },
        timeout: { type: 'string' },
        bootstrap: { type: 'string', multiple: true },
        output: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error))
  }

  const timeout = parsed.values.timeout === undefined ? 15_000 : Number(parsed.values.timeout)
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(timeout) || timeout > 2_147_483_647) {
    usage('--timeout must be a positive integer no greater than 2147483647 milliseconds')
  }

  const bootstrap = (parsed.values.bootstrap ?? []).flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    positionals: parsed.positionals,
    help: parsed.values.help === true,
    store: resolve(parsed.values.store ?? (process.env.RELAY_STORE || `${homedir()}/.pear-artifact`)),
    timeout,
    bootstrap,
    output: parsed.values.output,
    name: parsed.values.name,
    version: parsed.values.version,
    supplied: new Set(Object.keys(parsed.values).filter((name) => name !== 'help')),
  }
}

function requireArity(positionals: string[], count: number, command: string) {
  if (positionals.length !== count) usage(`${command} expects ${count} argument${count === 1 ? '' : 's'}`)
}

function requireAtMostArity(positionals: string[], count: number, command: string) {
  if (positionals.length > count) usage(`${command} expects at most ${count} argument${count === 1 ? '' : 's'}`)
}

function requireOption(value: string | undefined, option: string): string {
  if (!value) usage(`${option} is required`)
  return value
}

function identityPayload(registry: CliRegistry, store: string) {
  return { registryKey: registry.key, identity: registry.identity, store }
}

function emit(output: Output, value: unknown) {
  output.write(`${JSON.stringify(value)}\n`)
}

function connectInBackground(registry: CliRegistry, bootstrap: string[]) {
  try {
    const connected = registry.connect(bootstrap.length ? { bootstrap } : {})
    if (connected && typeof connected.catch === 'function') connected.catch(() => {})
  } catch {
    // A local registry remains useful when no peer is reachable.
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
}

async function boundedWorkflow<T>({ registry, signalSource, timeout, operation, work }: {
  registry: CliRegistry
  signalSource: Signals
  timeout: number
  operation: string
  work: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let cleanup = () => {}
  const stopped = new Promise<{ kind: 'interrupted'; error: Error }>((resolveStopped) => {
    const stop = (reason: Error | string) => {
      const interruption = reason instanceof Error ? reason : new Error(`Operation cancelled by ${reason}`)
      resolveStopped({ kind: 'interrupted', error: interruption })
    }
    const onInterrupt = () => stop('SIGINT')
    const onTerminate = () => stop('SIGTERM')
    timer = setTimeout(() => stop(new Error(`${operation} timed out after ${timeout}ms`)), timeout)
    signalSource.once('SIGINT', onInterrupt)
    signalSource.once('SIGTERM', onTerminate)
    cleanup = () => {
      clearTimeout(timer)
      signalSource.off('SIGINT', onInterrupt)
      signalSource.off('SIGTERM', onTerminate)
    }
  })
  const pending = Promise.resolve().then(() => work(controller.signal))
  const completed = pending.then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  )
  const result = await Promise.race([completed, stopped])
  cleanup()
  if (result.kind === 'value') return result.value
  if (result.kind === 'error') throw result.error

  controller.abort(result.error)
  await registry.close().catch(() => {})
  await pending.catch(() => {})
  throw result.error
}

function waitForShutdown(signalSource: Signals) {
  return new Promise<void>((resolveShutdown) => {
    const finish = () => {
      signalSource.off('SIGINT', finish)
      signalSource.off('SIGTERM', finish)
      resolveShutdown()
    }
    signalSource.once('SIGINT', finish)
    signalSource.once('SIGTERM', finish)
  })
}

function assertCommandOptions(command: string, options: ReturnType<typeof parseOptions>) {
  const commandOptions: Record<string, string[]> = {
    init: ['store'], join: ['store'], identity: ['store'], trust: ['store'], untrust: ['store'],
    publish: ['store', 'name', 'version'], fetch: ['store', 'timeout', 'bootstrap', 'output'],
    list: ['store', 'timeout', 'bootstrap'], seed: ['store', 'timeout', 'bootstrap'],
  }
  const allowed = commandOptions[command]
  if (!allowed) return
  for (const name of options.supplied) {
    if (!allowed.includes(name)) usage(`--${name} is not valid for ${command}`)
  }
}

export async function run(argv: string[], dependencies: CliDependencies = {}) {
  const output = dependencies.stdout ?? process.stdout
  const signalSource = dependencies.signalSource ?? process
  const factories = {
    initRegistry: dependencies.initRegistry ?? initRegistry,
    joinRegistry: dependencies.joinRegistry ?? joinRegistry,
    openRegistry: dependencies.openRegistry ?? openRegistry,
    createFileAccess: dependencies.createFileAccess ?? createFileAccess,
    publishArtifact: dependencies.publishArtifact ?? publishArtifact,
    fetchArtifact: dependencies.fetchArtifact ?? fetchArtifact,
    listArtifacts: dependencies.listArtifacts ?? listArtifacts,
    mirrorArtifact: dependencies.mirrorArtifact ?? mirrorArtifact,
  }
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    output.write(HELP)
    return
  }

  const options = parseOptions(rest)
  if (options.help) {
    output.write(HELP)
    return
  }
  assertCommandOptions(command, options)

  let registry: CliRegistry | undefined
  try {
    switch (command) {
      case 'init':
        requireArity(options.positionals, 0, command)
        registry = await factories.initRegistry(options.store)
        emit(output, identityPayload(registry, options.store))
        break
      case 'join':
        requireArity(options.positionals, 1, command)
        registry = await factories.joinRegistry(options.store, options.positionals[0])
        emit(output, identityPayload(registry, options.store))
        break
      case 'identity':
        requireArity(options.positionals, 0, command)
        registry = await factories.openRegistry(options.store)
        emit(output, identityPayload(registry, options.store))
        break
      case 'trust':
      case 'untrust':
        requireArity(options.positionals, 1, command)
        registry = await factories.openRegistry(options.store)
        await registry[command](options.positionals[0])
        emit(output, { identity: registry.identity, trustedPeers: registry.trustedPeers() })
        break
      case 'publish': {
        requireArity(options.positionals, 1, command)
        registry = await factories.openRegistry(options.store)
        const manifest = await factories.publishArtifact(
          { registry, files: factories.createFileAccess() },
          { source: options.positionals[0], name: requireOption(options.name, '--name'), version: requireOption(options.version, '--version') },
        )
        emit(output, manifest)
        break
      }
      case 'fetch': {
        requireArity(options.positionals, 1, command)
        registry = await factories.openRegistry(options.store)
        const activeRegistry = registry
        const files = factories.createFileAccess()
        const manifest = await boundedWorkflow({
          registry, signalSource, timeout: options.timeout, operation: 'Fetch',
          work: (signal) => {
            connectInBackground(activeRegistry, options.bootstrap)
            return factories.fetchArtifact(
              { registry: activeRegistry, files },
              { ...parseReference(options.positionals[0]), destination: requireOption(options.output, '--output'), signal },
            )
          },
        })
        emit(output, manifest)
        break
      }
      case 'list': {
        requireArity(options.positionals, 0, command)
        registry = await factories.openRegistry(options.store)
        const activeRegistry = registry
        emit(output, await boundedWorkflow({
          registry, signalSource, timeout: options.timeout, operation: 'List',
          work: async (signal) => {
            connectInBackground(activeRegistry, options.bootstrap)
            await activeRegistry.sync()
            throwIfAborted(signal)
            return factories.listArtifacts({ registry: activeRegistry })
          },
        }))
        break
      }
      case 'seed': {
        requireAtMostArity(options.positionals, 1, command)
        registry = await factories.openRegistry(options.store)
        const activeRegistry = registry
        const files = factories.createFileAccess()
        if (options.positionals[0]) {
          emit(output, await boundedWorkflow({
            registry, signalSource, timeout: options.timeout, operation: 'Seed',
            work: (signal) => {
              connectInBackground(activeRegistry, options.bootstrap)
              return factories.mirrorArtifact(
                { registry: activeRegistry, files },
                { ...parseReference(options.positionals[0]), signal },
              )
            },
          }))
        } else {
          connectInBackground(activeRegistry, options.bootstrap)
          emit(output, { identity: registry.identity, status: 'seeding' })
        }
        await waitForShutdown(signalSource)
        break
      }
      default:
        usage(`Unknown command: ${command}`)
    }
  } finally {
    if (registry) await registry.close()
  }
}

export async function main() {
  try {
    await run(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${HELP}`)
      process.exitCode = 1
      return
    }
    throw error
  }
}
