import { assertHash, type Catalog, type Hash } from './contracts.js'

export interface SourceEvent {
  id: string; documentId: string; createdAt: string
  kind: 'correction' | 'retraction' | 'access_revoked'; sourceHash: Hash; reason: string
}

export async function recordSourceEvent(catalog: Catalog, event: SourceEvent): Promise<void> {
  assertHash(event.sourceHash)
  if (!event.id?.trim() || !event.documentId?.trim() || !event.reason?.trim() ||
    !Number.isFinite(Date.parse(event.createdAt)) || !['correction', 'retraction', 'access_revoked'].includes(event.kind)) throw new Error('INVALID_SOURCE_EVENT')
  const [existing = []] = await catalog.transact([{ sql: 'SELECT body FROM source_events WHERE id = ?', params: [event.id] }])
  const body = JSON.stringify(event)
  if (existing.length) {
    if (existing[0]!.body !== body) throw new Error('SOURCE_EVENT_CONFLICT')
    return
  }
  await catalog.transact([{ sql: 'INSERT INTO source_events(id,document_id,body) VALUES(?,?,?)', params: [event.id, event.documentId, body] }])
}
