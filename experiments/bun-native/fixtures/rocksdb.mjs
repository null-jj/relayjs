import RocksDB from 'rocksdb-native'

const path = process.argv[2]
if (!path) throw new Error('Usage: rocksdb.mjs <database-path>')

async function openWriteReadClose() {
  const db = new RocksDB(path)
  try {
    await db.ready()
    await db.put('probe-key', 'probe-value')
    const value = await db.get('probe-key')
    if (value?.toString() !== 'probe-value') throw new Error('Initial read did not return the stored value')
  } finally {
    await db.close()
  }
}

await openWriteReadClose()

const reopened = new RocksDB(path)
try {
  await reopened.ready()
  const value = await reopened.get('probe-key')
  if (value?.toString() !== 'probe-value') throw new Error('Reopened database did not retain the stored value')
  console.log(JSON.stringify({ opened: true, wrote: true, read: true, reopened: true }))
} finally {
  await reopened.close()
}
