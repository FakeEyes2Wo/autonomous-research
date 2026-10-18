import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runControlledRecallBenchmark } from '../test/fixtures/idea-survey-recall.ts'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node --experimental-strip-types scripts/benchmark-idea-survey-recall.mjs [--output DIRECTORY]')
const output = args[1] ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'idea-survey-recall-benchmark-'))
const result = await runControlledRecallBenchmark(output)
console.log(JSON.stringify({ output, kind: result.kind, results: result.results.map(({ requests, reviewerCandidates, ...metrics }) => metrics) }, null, 2))
