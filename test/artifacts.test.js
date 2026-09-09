import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { parseReference, validateManifest } from '../dist/src/domain/artifact.js'
import { publishArtifact, fetchArtifact, mirrorArtifact } from '../dist/src/application/artifacts.js'
import { createFileAccess } from '../dist/src/infrastructure/files.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const blobs = new Map()
  const manifests = new Map()
  const registry = {
    writable: true,
    readManifest: async (n, v) => manifests.get(`${n}@${v}`) ?? null,
    writeManifest: async (n, v, m) => { manifests.set(`${n}@${v}`, m) },
    async writeBlob(id, stream) {
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      blobs.set(id, Buffer.concat(chunks))
    },
    readBlob: id => Readable.from([blobs.get(id)]),
    sync: async () => { throw new Error('Unexpected network access') },
  }
  return { directory, blobs, manifests, registry, files: createFileAccess() }
}

test('rejects ambiguous and unsafe artifact references', () => {
  assert.deepEqual(parseReference('my-app@1.0.0-beta'), { name: 'my-app', version: '1.0.0-beta' })
  for (const ref of ['app', 'app@', '../app@1', 'app@../1', 'app@1@2', '@scope/app@1', 'app@1/2']) {
    assert.throws(() => parseReference(ref))
  }
})

test('publish, offline fetch, and mirror preserve binary bytes; versions cannot be replaced', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from([0, 1, 255, 127, 10])
  const source = join(f.directory, 'build.bin')
  await writeFile(source, bytes)
  const request = { source, name: 'build', version: '1.0' }
  const manifest = await publishArtifact(f, request)
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(manifest.size, bytes.length)
  await assert.rejects(publishArtifact(f, request), /already exists/)
  f.registry.writable = false
  const destination = join(f.directory, 'download.bin')
  await fetchArtifact(f, { ...request, destination })
  assert.deepEqual(await readFile(destination), bytes)
  await mirrorArtifact(f, request)
  await assert.rejects(publishArtifact(f, { ...request, version: '2' }), /publisher/)
})

test('corrupted and oversized transfers leave no output or temporary download', async t => {
  const f = await fixture(t)
  const source = join(f.directory, 'build.bin')
  await writeFile(source, 'right')
  const request = { source, name: 'build', version: '1' }
  const manifest = await publishArtifact(f, request)
  const destination = join(f.directory, 'out.bin')
  for (const body of ['wrong', 'oversized']) {
    f.blobs.set(manifest.sha256, Buffer.from(body))
    await assert.rejects(fetchArtifact(f, { ...request, destination }), /integrity|declared size/)
    assert.deepEqual(await readdir(f.directory), ['build.bin'])
  }
})

test('verified exports refuse to overwrite existing files', async t => {
  const f = await fixture(t)
  const source = join(f.directory, 'build.bin')
  await writeFile(source, 'new')
  const request = { source, name: 'build', version: '1' }
  await publishArtifact(f, request)
  const destination = join(f.directory, 'out.bin')
  await writeFile(destination, 'keep me')
  await assert.rejects(fetchArtifact(f, { ...request, destination }), /already exists/)
  assert.equal(await readFile(destination, 'utf8'), 'keep me')
})

test('failed blob storage never publishes a manifest', async t => {
  const f = await fixture(t)
  const source = join(f.directory, 'build.bin')
  await writeFile(source, 'data')
  let failedStream
  f.registry.writeBlob = async (id, stream) => { failedStream = stream; stream.destroy(); throw new Error('Disk full') }
  await assert.rejects(publishArtifact(f, { source, name: 'build', version: '1' }), /Disk full/)
  assert.equal(f.manifests.size, 0)
  assert.equal(failedStream.closed, true, 'Publication must await reader closure before returning')
  await assert.rejects(readFile(failedStream.path), { code: 'ENOENT' })
})

test('manifest substitution is rejected before reading its blob', async t => {
  const f = await fixture(t)
  f.registry.readManifest = async () => ({ schema: 1, name: 'other', version: '1' })
  await assert.rejects(fetchArtifact(f, { name: 'build', version: '1', destination: 'unused' }), /does not match/)
  assert.throws(() => validateManifest({ schema: 2 }), /Unsupported/)
})

test('reader syncs on a cache miss and then retries the manifest', async t => {
  const f = await fixture(t)
  const source = join(f.directory, 'build.bin')
  await writeFile(source, '')
  const manifest = await publishArtifact(f, { source, name: 'empty', version: '1' })
  f.manifests.clear()
  f.registry.writable = false
  let synced = 0
  f.registry.sync = async () => { synced++; f.manifests.set('empty@1', manifest) }
  await fetchArtifact(f, { name: 'empty', version: '1', destination: join(f.directory, 'empty') })
  assert.equal(synced, 1)
  assert.equal((await readFile(join(f.directory, 'empty'))).length, 0)
})

test('aborted transfer destroys its source and removes partial output', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  let timer
  const source = new Readable({
    read() {
      timer = setTimeout(() => controller.abort(new Error('Deadline exceeded')), 10)
    },
    destroy(error, callback) { clearTimeout(timer); callback(error) },
  })
  await assert.rejects(f.files.exportVerified(source, join(f.directory, 'out'), { size: 1, sha256: '0'.repeat(64) }, { signal: controller.signal }), /abort/i)
  assert.equal(source.destroyed, true)
  assert.deepEqual(await readdir(f.directory), [])
})
