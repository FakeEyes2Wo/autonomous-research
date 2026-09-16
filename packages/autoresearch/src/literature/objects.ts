import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { assertHash, type Hash } from './contracts.js'

export function sha256(bytes: Uint8Array): Hash {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array')
  return createHash('sha256').update(bytes).digest('hex')
}

function objectPath(root: string, hash: Hash): string {
  return join(root, 'objects', hash.slice(0, 2), hash.slice(2))
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw error
  } finally {
    await handle?.close()
  }
}

export async function putObject(root: string, bytes: Uint8Array): Promise<Hash> {
  const hash = sha256(bytes)
  const target = objectPath(root, hash)
  const directory = join(root, 'objects', hash.slice(0, 2))
  await mkdir(directory, { recursive: true })

  try {
    await access(target, constants.F_OK)
    await readObject(root, hash)
    return hash
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = join(directory, `.${hash}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temporary, target)
    await syncDirectory(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await readObject(root, hash)
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
  return hash
}

export async function readObject(root: string, hashValue: Hash): Promise<Uint8Array> {
  const hash = assertHash(hashValue)
  let bytes: Buffer
  try {
    bytes = await readFile(objectPath(root, hash))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`object not found: ${hash}`, { cause: error })
    }
    throw error
  }
  if (sha256(bytes) !== hash) throw new Error(`object integrity check failed for ${hash}`)
  return new Uint8Array(bytes)
}
