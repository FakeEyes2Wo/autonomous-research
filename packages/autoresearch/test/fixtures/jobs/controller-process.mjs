import { readFile } from 'node:fs/promises'
import { openJobStore } from '../../../dist/runtime/job-store.js'
import { JobController } from '../../../dist/runtime/job-controller.js'
import { LocalJobBackend } from '../../../dist/runtime/executors/local.js'
process.on('disconnect', () => process.exit(0))
const [root, specPath, mode] = process.argv.slice(2)
const spec = JSON.parse(await readFile(specPath, 'utf8'))
const store = await openJobStore(root)
class PausingBackend extends LocalJobBackend {
  atFence(fence) { return new PausingBackend(store, fence) }
  async submit(...args) {
    await super.submit(...args)
    process.send({ stage: mode })
    return new Promise(() => {})
  }
}
const backend = mode === 'after-spawn' ? new PausingBackend(store) : new LocalJobBackend(store)
const controller = new JobController(store, backend)
await controller.enqueue(spec)
if (mode === 'before-submit') {
  process.send({ stage: mode })
} else if (mode === 'after-spawn') {
  controller.advance(spec.id).catch(error => { process.send({ error: String(error) }); process.exit(1) })
} else if (mode === 'before-collect') {
  await controller.advance(spec.id)
  while (!['succeeded', 'failed', 'cancelled'].includes((await store.get(spec.id)).receipt.status)) await new Promise(resolve => setTimeout(resolve, 30))
  process.send({ stage: mode })
}
setInterval(() => {}, 1000)
