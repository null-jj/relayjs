import type { Readable } from 'node:stream'
import type { ArtifactManifest } from '../domain/artifact.js'

export interface RegistryPort {
  readonly writable: boolean
  readManifest(name: string, version: string): Promise<unknown>
  writeManifest(name: string, version: string, manifest: ArtifactManifest): Promise<void>
  writeBlob(id: string, readable: Readable): Promise<void>
  readBlob(id: string): Readable
  listManifests(): Promise<unknown[]>
  sync(): Promise<number>
}

export interface Integrity {
  sha256: string
  size: number
}

export interface Snapshot extends Integrity {
  filename: string
  stream(): Readable
  cleanup(): Promise<void>
}

export interface TransferOptions { signal?: AbortSignal }

export interface FileAccess {
  prepare(source: string): Promise<Snapshot>
  exportVerified(readable: Readable, destination: string, manifest: Integrity, options?: TransferOptions): Promise<void>
  verify(readable: Readable, manifest: Integrity, options?: TransferOptions): Promise<void>
}

export interface ArtifactPorts {
  registry: RegistryPort
  files: FileAccess
}
