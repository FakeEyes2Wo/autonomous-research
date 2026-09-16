import { readFile } from 'node:fs/promises'
import { JobController, LocalJobBackend, openJobStore } from '../dist/runtime/index.js'

const [command, root, value, ...rest] = process.argv.slice(2)
if (!root || !['enqueue', 'advance', 'inspect', 'collect', 'cancel', 'resume', 'list', 'budget'].includes(command)) {
  console.error('Usage: runtime-job.mjs <enqueue|advance|inspect|collect|cancel|resume|list|budget> <job-root> [job-id|spec.json] [next-spec.json application-version]')
  process.exitCode = 2
} else {
  const store = await openJobStore(root)
  try {
    const backend = new LocalJobBackend(store), controller = new JobController(store, backend)
    let result
    switch (command) {
      case 'enqueue': result = await controller.enqueue(JSON.parse(await readFile(value, 'utf8'))); break
      case 'advance': result = await controller.advance(value); break
      case 'inspect': result = await backend.inspect(value); break
      case 'collect': result = await backend.collect(value); break
      case 'cancel': result = await controller.cancel(value); break
      case 'resume': result = await controller.resume(value, JSON.parse(await readFile(rest[0], 'utf8')), rest[1]); break
      case 'list': result = await store.list(); break
      case 'budget': result = await store.budget(); break
    }
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  finally { await store.close() }
}
