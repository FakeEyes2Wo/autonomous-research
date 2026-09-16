import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openCatalog } from '../../dist/literature/catalog.js'
import type { Catalog } from '../../dist/literature/contracts.js'

export async function withLibrary<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ar-lit-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function withCatalog<T>(callback: (root: string, catalog: Catalog) => Promise<T>): Promise<T> {
  return withLibrary(async root => {
    const catalog = await openCatalog(root)
    try {
      return await callback(root, catalog)
    } finally {
      await catalog.close()
    }
  })
}
