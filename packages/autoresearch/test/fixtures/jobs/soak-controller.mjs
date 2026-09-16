// Fault injection belongs in this test-only controller, never the runtime.
import { openJobStore } from '../../../dist/runtime/job-store.js'
import { JobController } from '../../../dist/runtime/job-controller.js'
import { LocalJobBackend } from '../../../dist/runtime/executors/local.js'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
const [root, limitsJson] = process.argv.slice(2)
const store = await openJobStore(root, JSON.parse(limitsJson))
const controller = new JobController(store, new LocalJobBackend(store))
process.on('disconnect', () => process.exit(0))
process.send({ type: 'ready', pid: process.pid })
let queue = Promise.resolve()
process.on('message', message => {
  queue = queue.then(async () => {
    try {
      let value
      switch (message.op) {
        case 'enqueue': value = await controller.enqueue(message.spec); break
        case 'get': value = await store.get(message.jobId); break
        case 'advance': value = await controller.advance(message.jobId); break
        case 'cancel': value = await controller.cancel(message.jobId, 'soak controlled cancellation'); break
        case 'snapshot': value = { jobs: await store.list(), budget: await store.budget(), rss: process.memoryUsage().rss }; break
        case 'prepare-unknown': {
          const job = await store.claim(message.jobId, controller.owner)
          await store.beginSubmission(message.jobId, job.fence)
          const nonce = randomUUID()
          await store.prepareSpawn(message.jobId, job.fence, { nonce, startupId: randomUUID(), host: hostname(), socket: `\\\\.\\pipe\\soak-delayed-${nonce}`, pid: null })
          await store.release(message.jobId, job.fence)
          value = await controller.advance(message.jobId)
          break
        }
        case 'crash-after-spawn': {
          class LostResponseBackend extends LocalJobBackend {
            atFence(fence) { return new LostResponseBackend(store, fence) }
            async submit(...args) {
              await super.submit(...args)
              process.send({ id: message.id, value: { stage: 'after-spawn', budget: await store.budget() } })
              return new Promise(() => {})
            }
          }
          await new JobController(store, new LostResponseBackend(store)).advance(message.jobId)
          return
        }
        default: throw new Error(`unknown soak command ${message.op}`)
      }
      process.send({ id: message.id, value })
    } catch (error) { process.send({ id: message.id, error: String(error) }) }
  })
})
