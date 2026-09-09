import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
const { run } = createRequire(import.meta.url)('./async-work.node')
let ticks = 0
const timer = setInterval(() => ticks++, 5)
try {
  const results = await Promise.all(Array.from({ length: 8 }, () => run(false)))
  assert.ok(ticks > 0, 'Native work must not block the JS event loop')
  for (const result of results) {
    assert.equal(result.offThread, true)
    assert.equal(result.status, 0)
  }
  const cancellations = await Promise.all(Array.from({ length: 16 }, () => run(true)))
  assert.ok(cancellations.some(result => result.cancelStatus === 0), 'Must exercise successful queued cancellation')
  for (const result of cancellations) {
    if (result.cancelStatus === 0) {
      assert.equal(result.status, -constants.errno.ECANCELED)
      assert.equal(result.offThread, false, 'Canceled queued work must not execute')
    } else {
      assert.equal(result.cancelStatus, -constants.errno.EBUSY)
      assert.equal(result.status, 0)
      assert.equal(result.offThread, true)
    }
  }
  const started = await run(true, true)
  assert.equal(started.cancelStatus, -constants.errno.EBUSY, 'Running work cannot be canceled')
  assert.equal(started.status, 0)
  assert.equal(started.offThread, true)
  console.log(JSON.stringify({ asyncWork: true }))
} finally {
  clearInterval(timer)
}
