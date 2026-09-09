import type { FileAccess, Integrity } from '../application/ports.js'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, mkdir, mkdtemp, rm, link } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

function meter(expected?: Integrity) {
  const hash = createHash('sha256')
  let size = 0
  const stream: Transform & { result?: Integrity } = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (!Number.isSafeInteger(size) || (expected && size > expected.size)) {
        callback(new Error('Artifact exceeds its declared size'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      const sha256 = hash.digest('hex')
      stream.result = { sha256, size }
      if (expected && (size !== expected.size || sha256 !== expected.sha256)) {
        callback(new Error('Artifact integrity verification failed (size or SHA-256 mismatch)'))
        return
      }
      callback()
    },
  })
  return stream
}

export function createFileAccess(): FileAccess {
  return {
    async prepare(source) {
      const handle = await open(source, 'r')
      let directory: string | undefined
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Publish source must be a regular file')
        const snapshotDirectory = directory = await mkdtemp(join(tmpdir(), 'pear-artifact-publish-'))
        const path = join(directory, 'snapshot')
        const measured = meter()
        await pipeline(handle.createReadStream(), measured, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        if (!measured.result) throw new Error('File hashing did not complete')
        const readers = new Set<ReturnType<typeof createReadStream>>()
        return {
          ...measured.result, filename: basename(source),
          stream: () => {
            const reader = createReadStream(path)
            readers.add(reader)
            // A consumer can cancel before fs.open completes. Keep that delayed
            // error observed while pipeline consumers still receive it normally.
            reader.on('error', () => {})
            reader.once('close', () => readers.delete(reader))
            return reader
          },
          cleanup: async () => {
            const closing = [...readers].map(reader => new Promise<void>(resolve => {
              if (reader.closed) return resolve()
              reader.once('close', resolve)
              reader.destroy()
            }))
            await Promise.all(closing)
            await rm(snapshotDirectory, { recursive: true, force: true })
          },
        }
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true })
        throw error
      } finally {
        await handle.close()
      }
    },

    async exportVerified(readable, destination, manifest, { signal } = {}) {
      let directory: string | undefined
      try {
        if (!destination) throw new Error('An output path is required')
        signal?.throwIfAborted()
        const target = resolve(destination)
        await mkdir(dirname(target), { recursive: true })
        directory = await mkdtemp(join(dirname(target), '.pear-artifact-fetch-'))
        const temporary = join(directory, 'download')
        await pipeline(readable, meter(manifest), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
        // A same-filesystem hard link publishes complete verified bytes without
        // replacing an existing path, including a symlink created concurrently.
        signal?.throwIfAborted()
        await link(temporary, target)
      } catch (error) {
        readable.destroy()
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('Output already exists; choose a different path')
        throw error
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    },

    async verify(readable, manifest, { signal } = {}) {
      await pipeline(readable, meter(manifest), new Writable({ write(chunk, encoding, callback) { callback() } }), { signal })
    },
  }
}
