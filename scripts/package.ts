import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'relayjs')
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
if (process.env.RELEASE_TAG) {
  assert.equal(process.env.RELEASE_TAG, `v${manifest.version}`, 'Release tag must match package.json version')
}

// Clean only the shipped compiler outputs; keep unrelated local experiments.
await Promise.all(['bin', 'src'].map(name => rm(join(root, 'dist', name), { recursive: true, force: true })))
await exec(process.execPath, ['run', 'build'], { cwd: root })
const stage = await mkdtemp(join(tmpdir(), 'relayjs-package-'))
try {
  for (const path of manifest.files as string[]) {
    await cp(join(root, path), join(stage, path), { recursive: true, dereference: true })
  }
  // Consumers receive ready-to-run JS and runtime dependencies, not development
  // lifecycle scripts that would require Bun or TypeScript during installation.
  const packaged = { ...manifest, engines: { node: manifest.engines.node } }
  delete packaged.scripts
  delete packaged.devDependencies
  delete packaged.packageManager
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(packaged, null, 2)}\n`)
  await chmod(join(stage, 'dist/bin/relay.js'), 0o755)
  const filename = `relayjs-${manifest.version}.tgz`
  await exec(process.execPath, ['pm', 'pack', '--ignore-scripts', '--filename', filename], { cwd: stage })
  const bytes = await readFile(join(stage, filename))
  const output = join(root, 'artifacts')
  await mkdir(output, { recursive: true })
  // Copy first: the OS temp directory may be on a different filesystem.
  const pending = join(output, `${filename}.tmp`)
  await cp(join(stage, filename), pending)
  await rename(pending, join(output, filename))
  await writeFile(join(output, `${filename}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`)
  console.log(`Packaged artifacts/${filename} and its SHA-256 checksum`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
