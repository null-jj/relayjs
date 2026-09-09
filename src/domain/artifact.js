const segment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export function validateReference(name, version) {
  if (typeof name !== 'string' || !segment.test(name)) {
    throw new Error('Name must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  }
  if (typeof version !== 'string' || !segment.test(version)) {
    throw new Error('Version must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit')
  }
  return { name, version }
}

export function parseReference(value) {
  if (typeof value !== 'string' || value.split('@').length !== 2) {
    throw new Error('Use an exact artifact reference: NAME@VERSION')
  }
  return validateReference(...value.split('@'))
}

export function validateManifest(manifest, expected) {
  if (!manifest || manifest.schema !== 1) throw new Error('Unsupported artifact manifest')
  validateReference(manifest.name, manifest.version)
  if (expected && (manifest.name !== expected.name || manifest.version !== expected.version)) {
    throw new Error('Manifest does not match the requested artifact')
  }
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('Manifest contains an invalid SHA-256 digest')
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) throw new Error('Manifest contains an invalid size')
  if (typeof manifest.filename !== 'string' || manifest.filename.length < 1 || manifest.filename.length > 255 || /[\x00-\x1f/\\]/.test(manifest.filename)) {
    throw new Error('Manifest contains an invalid filename')
  }
  return manifest
}
