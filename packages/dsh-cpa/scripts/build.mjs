import { cp, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await cp(join(root, 'src'), dist, { recursive: true })
await import(pathToFileURL(join(dist, 'index.mjs')).href)
console.log('Built @athena/dsh-cpa to ' + dist)
