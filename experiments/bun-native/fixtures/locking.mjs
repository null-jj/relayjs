import assert from 'node:assert/strict'
import { openSync, closeSync } from 'node:fs'
import fsx from 'fs-native-extensions'

const [mode, path] = process.argv.slice(2)
const fd = openSync(path, 'a+', 0o600)
let holding = false
try {
  if (mode === 'errors') {
    assert.throws(() => fsx.tryLock(-1), { code: 'EBADF' })
    fsx.setAttrSync(fd, 'user.relayjs-probe', Buffer.from('preserved'))
    assert.equal(fsx.getAttrSync(fd, 'user.relayjs-probe').toString(), 'preserved')
    fsx.removeAttrSync(fd, 'user.relayjs-probe')
    await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const name = `user.relayjs-async-${index}`
      const value = Buffer.from(`value-${index}`)
      await fsx.setAttr(fd, name, value)
      assert.deepEqual(await fsx.getAttr(fd, name), value)
      await fsx.removeAttr(fd, name)
      assert.equal(await fsx.getAttr(fd, name), null)
    }))
    await assert.rejects(fsx.getAttr(-1, 'user.relayjs-invalid'), { code: 'EBADF' })
    console.log(JSON.stringify({ errorsAndMetadata: true }))
  } else {
    const locked = fsx.tryLock(fd)
    if (mode === 'hold' && locked) {
      holding = true
      const timer = setInterval(() => {}, 1000)
      const stop = () => {
        fsx.unlock(fd)
        closeSync(fd)
        clearInterval(timer)
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    }
    console.log(JSON.stringify({ locked }))
    if (locked && !holding) fsx.unlock(fd)
  }
} finally {
  if (!holding) closeSync(fd)
}
