// Diagnostic: abrupt Worker termination currently fails in rebuilt native addons.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { openSync } from 'node:fs'
if (isMainThread) {
  for (let index = 0; index < 8; index++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: process.argv[2] })
    await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    await worker.terminate()
  }
  console.log(JSON.stringify({ workerTeardown: true }))
} else {
  const { default: fsx } = await import('fs-native-extensions')
  const fd = openSync(workerData, 'a+', 0o600)
  for (let index = 0; index < 2000; index++) {
    fsx.setAttr(fd, 'user.teardown', Buffer.from('pending')).catch(() => {})
  }
  parentPort.postMessage('queued')
  setInterval(() => {}, 1000)
}
