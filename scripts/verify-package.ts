import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarball = resolve(process.argv[2] || join(root, 'artifacts', `relayjs-${source.version}.tgz`))
const checksum = (await readFile(`${tarball}.sha256`, 'utf8')).split(/\s+/)[0]
assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), checksum, 'Package checksum mismatch')
const sandbox = await mkdtemp(join(tmpdir(), 'relayjs-install-'))
try {
  await writeFile(join(sandbox, 'package.json'), '{"private":true}\n')
  await exec(process.execPath, ['add', '--production', tarball], {
    cwd: sandbox, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  })
  const installed = join(sandbox, 'node_modules/relayjs')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(await readFile(join(installed, 'docs/releases.md'), 'utf8'), await readFile(join(root, 'docs/releases.md'), 'utf8'))
  assert.equal(manifest.version, source.version)
  assert.equal(manifest.bin.relay, './dist/bin/relay.js')
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.engines.bun, undefined)
  const entries = await readdir(installed)
  for (const excluded of ['src', 'bin', 'scripts', 'test', 'experiments', 'node_modules', 'bun.lock']) {
    assert.ok(!entries.includes(excluded), `Development file shipped: ${excluded}`)
  }
  assert.deepEqual((await readdir(join(installed, 'dist'))).sort(), ['bin', 'src'])
  const bin = join(sandbox, 'node_modules/.bin/relay')
  const store = join(sandbox, 'registry')
  const cli = (args: string[]) => exec(bin, args, { cwd: sandbox, timeout: 20_000, killSignal: 'SIGKILL' })
  assert.match((await cli(['--help'])).stdout, /Usage: relay <command>/)
  const identity = JSON.parse((await cli(['init', '--store', store])).stdout)
  assert.match(identity.registryKey, /^[0-9a-f]{64}$/)
  const bytes = Buffer.alloc(200_000, 123)
  const input = join(sandbox, 'input.bin')
  const output = join(sandbox, 'output.bin')
  await writeFile(input, bytes)
  await cli(['publish', input, '--name', 'package-check', '--version', '1', '--store', store])
  // Use only an isolated loopback bootstrap; the bytes are already local.
  const fetch = ['fetch', 'package-check@1', '--store', store, '--output', output, '--bootstrap', '127.0.0.1:9']
  await cli(fetch)
  assert.deepEqual(await readFile(output), bytes)
  await assert.rejects(cli(fetch), /Output already exists/)
  assert.deepEqual(await readFile(output), bytes)
  console.log('PASS: tarball installation, CLI entry point, native storage, publish/fetch, and overwrite protection')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
