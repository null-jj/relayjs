import type { ArtifactPorts, RegistryPort, TransferOptions } from './ports.js'
import type { ArtifactReference } from '../domain/artifact.js'

interface PublishRequest extends ArtifactReference { source: string }
interface FetchRequest extends ArtifactReference, TransferOptions { destination: string }

import { validateReference, validateManifest } from '../domain/artifact.js'

// Ports: registry stores manifests and blob streams; files snapshots, verifies,
// and atomically exports streams. Neither port exposes Hyperdrive to use cases.
export async function publishArtifact({ registry, files }: ArtifactPorts, { source, name, version }: PublishRequest) {
  validateReference(name, version)
  if (!registry.writable) throw new Error('Only the registry publisher can publish artifacts')
  if (await registry.readManifest(name, version)) throw new Error(`${name}@${version} already exists; publish a new version`)
  const snapshot = await files.prepare(source)
  try {
    const manifest = validateManifest({
      schema: 1, name, version, filename: snapshot.filename,
      size: snapshot.size, sha256: snapshot.sha256,
    })
    await registry.writeBlob(manifest.sha256, snapshot.stream())
    // Commit the discoverable version only after the complete blob is stored.
    await registry.writeManifest(name, version, manifest)
    return manifest
  } finally {
    await snapshot.cleanup()
  }
}

async function resolveManifest(registry: RegistryPort, name: string, version: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  validateReference(name, version)
  let manifest = await registry.readManifest(name, version)
  if (!manifest && !registry.writable) {
    await registry.sync()
    manifest = await registry.readManifest(name, version)
  }
  if (!manifest) throw new Error(`Artifact not found: ${name}@${version}`)
  signal?.throwIfAborted()
  return validateManifest(manifest, { name, version })
}

export async function fetchArtifact({ registry, files }: ArtifactPorts, { name, version, destination, signal }: FetchRequest) {
  const manifest = await resolveManifest(registry, name, version, signal)
  await files.exportVerified(registry.readBlob(manifest.sha256), destination, manifest, { signal })
  return manifest
}

export async function mirrorArtifact({ registry, files }: ArtifactPorts, { name, version, signal }: ArtifactReference & TransferOptions) {
  const manifest = await resolveManifest(registry, name, version, signal)
  await files.verify(registry.readBlob(manifest.sha256), manifest, { signal })
  return manifest
}

export async function listArtifacts({ registry }: { registry: RegistryPort }) {
  return (await registry.listManifests()).map(manifest => validateManifest(manifest))
}
