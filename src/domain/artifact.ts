export interface ArtifactReference { name: string; version: string }

export interface ArtifactManifest extends ArtifactReference {
  schema: 1
  filename: string
  size: number
  sha256: string
}

const segment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export function validateReference(name: unknown, version: unknown): ArtifactReference {
  if (typeof name !== 'string' || !segment.test(name)) {
    throw new Error('Name must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  }
  if (typeof version !== 'string' || !segment.test(version)) {
    throw new Error('Version must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  }
  return { name, version }
}

export function parseReference(value: unknown): ArtifactReference {
  if (typeof value !== 'string' || value.split('@').length !== 2) {
    throw new Error('Use an exact artifact reference: NAME@VERSION')
  }
  const [name, version] = value.split('@')
  return validateReference(name, version)
}

export function validateManifest(input: unknown, expected?: ArtifactReference): ArtifactManifest {
  if (!input || typeof input !== 'object') throw new Error('Unsupported artifact manifest')
  const manifest = input as Record<string, unknown>
  if (manifest.schema !== 1) throw new Error('Unsupported artifact manifest')
  validateReference(manifest.name, manifest.version)
  if (expected && (manifest.name !== expected.name || manifest.version !== expected.version)) {
    throw new Error('Manifest does not match the requested artifact')
  }
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('Manifest contains an invalid SHA-256 digest')
  }
  if (typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size < 0) throw new Error('Manifest contains an invalid size')
  if (typeof manifest.filename !== 'string' || manifest.filename.length < 1 || manifest.filename.length > 255 || /[\x00-\x1f/\\]/.test(manifest.filename)) {
    throw new Error('Manifest contains an invalid filename')
  }
  return {
    schema: 1, ...validateReference(manifest.name, manifest.version),
    sha256: manifest.sha256, size: manifest.size, filename: manifest.filename,
  }
}
