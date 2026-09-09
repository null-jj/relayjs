import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const storageOnly = process.argv.includes('--storage-only')
const workerTeardown = process.argv.includes('--worker-teardown')
const lockingOnly = process.argv.includes('--locking-only')
if (process.argv.slice(2).some(arg => !['--locking-only', '--worker-teardown', '--storage-only'].includes(arg))) {
  throw new Error('Usage: bun scripts/verify-bun-native.ts [--locking-only|--storage-only] [--worker-teardown]')
}
if (lockingOnly && storageOnly) throw new Error('Choose either --locking-only or --storage-only')
if (process.platform !== 'linux') throw new Error('The native rebuild experiment currently supports Linux only')
const bun = process.env.RELAY_BUN_BIN || 'bun'
const node = process.env.RELAY_NODE_BIN || 'node'
const compiler = process.env.CC || 'cc'
const nodeHeaders = process.env.RELAY_NODE_INCLUDE || '/usr/include/node'
const uvHeaders = process.env.RELAY_UV_INCLUDE || '/usr/include'
const children = new Set<ChildProcess>()
let interrupted = false
function interrupt(signal: NodeJS.Signals) {
  interrupted = true
  process.exitCode = signal === 'SIGINT' ? 130 : 143
  for (const child of children) child.kill('SIGKILL')
}
const onInterrupt = () => interrupt('SIGINT')
const onTerminate = () => interrupt('SIGTERM')

interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function start(command: string, args: string[], cwd: string) {
  if (interrupted) throw new Error('Native probe interrupted')
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = ''
  let stderr = ''
  let resolveLine: (line: string) => void
  let rejectLine: (error: Error) => void
  const firstLine = new Promise<string>((accept, reject) => { resolveLine = accept; rejectLine = reject })
  // Most processes don't have a ready handshake; still consume early failures.
  firstLine.catch(() => {})
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    if (stdout.includes('\n')) resolveLine(stdout.slice(0, stdout.indexOf('\n')))
  })
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<Result>((accept, reject) => {
    child.once('error', error => { children.delete(child); rejectLine(error); reject(error) })
    child.once('close', (code, signal) => {
      children.delete(child)
      rejectLine(new Error(`Process exited before reporting ready: ${stderr}`))
      accept({ code, signal, stdout, stderr })
    })
  })
  done.catch(() => {})
  return { child, done, firstLine }
}

async function bounded<T>(promise: Promise<T>, child: ChildProcess, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Native probe timed out after ${milliseconds}ms`)) }, milliseconds)
      }),
    ])
  } finally { clearTimeout(timer) }
}

async function run(command: string, args: string[], cwd: string) {
  const process = start(command, args, cwd)
  return bounded(process.done, process.child, 30_000)
}
function success(result: Result) {
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null, result.stderr)
}
function summary(result: Result) {
  if (result.code === 0 && result.signal === null) return { code: 0, signal: null }
  const missing = result.stderr.match(/unsupported uv function: ([a-zA-Z0-9_]+)/)?.[1]
  return { code: result.code, signal: result.signal, ...(missing ? { missingFunction: missing } : { stderr: result.stderr.slice(-1500) }) }
}

const sandbox = await mkdtemp(join(tmpdir(), 'relayjs-bun-native-check-'))
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)
try {
  await Promise.all([access(join(nodeHeaders, 'node_api.h')), access(join(uvHeaders, 'uv.h'))])
  const version = JSON.parse(await readFile(join(root, 'node_modules/fs-native-extensions/package.json'), 'utf8')).version
  if (version !== '1.5.1') throw new Error(`Expected fs-native-extensions 1.5.1, found ${version}; review the patch before updating`)
  // Copies, never hardlinks: replacing the probe's addon cannot affect the
  // installed production addon or Bun's shared package cache.
  await cp(join(root, 'node_modules'), join(sandbox, 'node_modules'), { recursive: true, dereference: true })
  await cp(join(root, 'dist'), join(sandbox, 'dist'), { recursive: true, dereference: true })
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'))
  for (const name of ['locking', 'registry', 'rocksdb', 'async-work', 'worker-teardown']) {
    await cp(join(root, `experiments/bun-native/fixtures/${name}.mjs`), join(sandbox, `${name}.mjs`))
  }
  if (process.env.RELAY_ROCKSDB_ADDON) {
    const rocks = join(sandbox, 'node_modules/rocksdb-native')
    const version = JSON.parse(await readFile(join(rocks, 'package.json'), 'utf8')).version
    assert.equal(version, '3.17.4', 'Review the RocksDB patch before updating its version')
    const target = join(rocks, `prebuilds/linux-${process.arch}/rocksdb-native.node`)
    assert.ok((await realpath(dirname(target))).startsWith(`${await realpath(sandbox)}${sep}`))
    await rm(target, { force: true })
    await cp(resolve(process.env.RELAY_ROCKSDB_ADDON), target, { dereference: true })
  }
  const native = join(sandbox, 'node_modules/fs-native-extensions')
  const prebuild = join(native, `prebuilds/linux-${process.arch}`)
  await mkdir(prebuild, { recursive: true })
  const output = join(prebuild, 'fs-native-extensions.node')
  assert.ok((await realpath(prebuild)).startsWith(`${await realpath(sandbox)}${sep}`), 'Native output must stay inside the sandbox')
  // Remove any existing output link before the compiler opens its destination.
  await rm(output, { force: true })
  const binding = join(native, 'binding.c')
  const source = await readFile(binding, 'utf8')
  const entry = 'fs_ext_js_exports(js_env_t *env, js_value_t *exports) {'
  assert.equal(source.split(entry).length, 2, 'Expected one addon initializer')
  await writeFile(binding, source.replace(entry, `${entry}\n  relayjs_async_init((napi_env) env);`))
  const compiled = await run(compiler, [
    '-shared', '-fPIC', '-O2', '-D_GNU_SOURCE=', '-DNAPI_VERSION=9',
    `-I${nodeHeaders}`, `-I${uvHeaders}`,
    `-I${join(root, 'node_modules/bare-compat-napi/include')}`,
    '-include', join(root, 'experiments/bun-native/posix-compat.h'),
    '-include', join(root, 'experiments/bun-native/async-work.h'),
    join(root, 'experiments/bun-native/async-work.c'),
    join(native, 'binding.c'), join(native, 'src/shared.c'),
    join(native, 'src/posix.c'), join(native, 'src/linux.c'),
    '-o', output,
  ], sandbox)
  success(compiled)
  success(await run(compiler, [
    '-O2', '-D_GNU_SOURCE=', `-I${uvHeaders}`,
    join(root, 'experiments/bun-native/fixtures/posix-fs.c'),
    '-o', join(sandbox, 'posix-fs'),
  ], sandbox))
  success(await run(join(sandbox, 'posix-fs'), [join(sandbox, 'posix-data')], sandbox))
  console.log('PASS: POSIX file bytes, offsets, descriptor flags, and error handling.')
  success(await run(compiler, [
    '-shared', '-fPIC', '-O2', '-D_GNU_SOURCE=', '-DNAPI_VERSION=9',
    `-I${nodeHeaders}`, `-I${uvHeaders}`,
    join(root, 'experiments/bun-native/async-work.c'),
    join(root, 'experiments/bun-native/fixtures/async-work.c'),
    '-o', join(sandbox, 'async-work.node'),
  ], sandbox))
  for (const runtime of [node, bun]) {
    const result = await run(runtime, ['async-work.mjs'], sandbox)
    success(result)
    assert.equal(JSON.parse(result.stdout).asyncWork, true)
  }
  console.log('PASS: native background execution, event-loop progress, and cancellation.')
  console.log('Rebuilt the isolated addon; installed dependencies remain untouched.')
  for (const runtime of [node, bun]) {
    const result = await run(runtime, ['locking.mjs', 'errors', join(sandbox, 'metadata')], sandbox)
    success(result)
    assert.equal(JSON.parse(result.stdout).errorsAndMetadata, true)
  }
  for (const [owner, contender] of [[node, bun], [bun, node]]) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const file = join(sandbox, 'lock')
      const holder = start(owner!, ['locking.mjs', 'hold', file], sandbox)
      assert.equal(JSON.parse(await bounded(holder.firstLine, holder.child)).locked, true)
      const conflict = await run(contender!, ['locking.mjs', 'try', file], sandbox)
      success(conflict)
      assert.equal(JSON.parse(conflict.stdout).locked, false, 'Concurrent lock must be rejected')
      holder.child.kill(signal)
      const stopped = await bounded(holder.done, holder.child)
      if (signal === 'SIGTERM') success(stopped)
      else assert.equal(stopped.signal, 'SIGKILL')
      const released = await run(contender!, ['locking.mjs', 'try', file], sandbox)
      success(released)
      assert.equal(JSON.parse(released.stdout).locked, true, 'OS must release the lock after shutdown')
    }
  }
  console.log('PASS: Node/Bun lock contention, graceful release, crash release, errors, and synchronous/asynchronous metadata.')
  if (workerTeardown) {
    for (const runtime of [node, bun]) {
      success(await run(runtime, ['worker-teardown.mjs', join(sandbox, 'worker-data')], sandbox))
    }
  }
  if (!lockingOnly) {
    success(await run(node, ['registry.mjs', join(sandbox, 'node-registry')], sandbox))
    const registry = await run(bun, ['registry.mjs', join(sandbox, 'bun-registry')], sandbox)
    const rocksdb = await run(bun, ['rocksdb.mjs', join(sandbox, 'bun-rocksdb')], sandbox)
    console.log(JSON.stringify({ registry: summary(registry), rocksdb: summary(rocksdb) }, null, 2))
    if (registry.code !== 0 || rocksdb.code !== 0) {
      console.error('Bun storage integration is still blocked. Native storage is not yet ready for a runtime migration.')
      process.exitCode = 1
    } else {
      await cp(join(root, 'test'), join(sandbox, 'test'), { recursive: true, dereference: true })
      // Bypass the production Bun guard only in this disposable acceptance copy.
      await writeFile(join(sandbox, 'dist/bin/relay.js'), `import { main } from '../src/cli.js';
main().catch(error => { console.error('Error: ' + error.message); process.exitCode = 1 });
`)
      const tests = (await readdir(join(sandbox, 'test'))).filter(name => name.endsWith('.test.js') && (!storageOnly || ['artifacts.test.js', 'persistence.test.js', 'cli.test.js'].includes(name))).sort().map(name => `test/${name}`)
      const acceptance = await run(bun, ['test', ...tests], sandbox)
      console.log(JSON.stringify({ acceptance: summary(acceptance) }, null, 2))
      if (acceptance.code !== 0 || acceptance.signal) {
        process.exitCode = 1
        console.error('Bun acceptance failed; keep the production Node runtime.')
      } else {
        console.log(acceptance.stdout + acceptance.stderr)
        console.log(storageOnly ? 'PASS: Bun storage and offline CLI acceptance.' : 'PASS: Bun storage and peer-transfer acceptance.')
      }
    }
  }
} catch (error) {
  if (!interrupted) throw error
} finally {
  const pending = [...children].map(child => new Promise<void>(accept => {
    child.once('close', () => accept())
    child.kill('SIGKILL')
  }))
  await Promise.all(pending)
  await rm(sandbox, { recursive: true, force: true })
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
}
