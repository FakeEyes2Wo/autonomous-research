import { API_PREFIX } from './contract.js'

const PREFIX = `${API_PREFIX}/literature`
const MAX_BODY_BYTES = 512 * 1024
const problem = (status, code) => Object.assign(new Error(code), { status, code })

function json(res, status, body, headers = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(JSON.stringify(body))
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function boundedText(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw problem(400, `invalid_${name}`)
  return value
}

async function readBody(req) {
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw problem(415, 'json_required')
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw problem(413, 'body_too_large')
    chunks.push(Buffer.from(chunk))
  }
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw problem(400, 'invalid_json') }
  if (!object(body)) throw problem(400, 'invalid_request')
  return body
}

function hasLocalPath(value) {
  if (Array.isArray(value)) return value.some(hasLocalPath)
  if (!object(value)) return false
  return Object.entries(value).some(([key, item]) => ['path', 'root', 'file', 'localPath', 'filePath'].includes(key) || hasLocalPath(item))
}

function source(res, req, result) {
  if (!result) throw problem(404, 'source_not_found')
  const bytes = Buffer.from(result.bytes)
  const pdf = result.mediaType?.split(';')[0].trim().toLowerCase() === 'application/pdf'
  res.setHeader('content-type', pdf ? 'application/pdf' : 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', "default-src 'none'; sandbox")
  let start = 0
  let end = bytes.length - 1
  let partial = false
  if (pdf) {
    res.setHeader('accept-ranges', 'bytes')
    const range = req.headers.range
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range))
      if (match && (match[1] || match[2])) {
        if (!match[1]) {
          const length = Number(match[2])
          start = Math.max(0, bytes.length - length)
          partial = Number.isSafeInteger(length) && length > 0
        } else {
          start = Number(match[1])
          end = match[2] ? Number(match[2]) : end
          partial = Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
          end = Math.min(end, bytes.length - 1)
        }
      }
      if (!partial || start >= bytes.length || bytes.length === 0) return json(res, 416, { error: { code: 'invalid_range', message: 'Requested byte range is unavailable.' } }, { 'content-range': `bytes */${bytes.length}` })
    }
  }
  const selected = partial ? bytes.subarray(start, end + 1) : bytes
  res.statusCode = partial ? 206 : 200
  if (partial) res.setHeader('content-range', `bytes ${start}-${end}/${bytes.length}`)
  res.setHeader('content-length', selected.length)
  res.end(req.method === 'HEAD' ? undefined : selected)
}

/** The host API applies loopback/same-origin/CSRF before delegating here. Roots come only from getProject. */
export function createLiterature(hooks) {
  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false
      try {
        const route = url.pathname.slice(PREFIX.length)
        const writes = ['/import', '/index']
        const reads = ['/papers', '/search', '/source', '/span', '/operations']
        if (!writes.includes(route) && !reads.includes(route)) throw problem(404, 'not_found')
        if (writes.includes(route) ? req.method !== 'POST' : req.method !== 'GET' && !(route === '/source' && req.method === 'HEAD')) throw problem(405, 'method_not_allowed')
        const body = writes.includes(route) ? await readBody(req) : null
        if (body && hasLocalPath(body)) throw problem(400, 'local_path_not_allowed')
        const projectId = boundedText(body?.projectId ?? url.searchParams.get('projectId'), 'project_id', 200)
        const project = await hooks.getProject(projectId)
        if (!project) throw problem(404, 'project_not_found')
        const scope = { projectId: project.id, root: project.root }
        let result
        if (route === '/papers') {
          const raw = url.searchParams.get('limit') ?? '25'
          const limit = Number(raw)
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw problem(400, 'invalid_limit')
          const afterId = url.searchParams.get('afterId')
          result = await hooks.listPapers({ ...scope, limit, ...(afterId ? { afterId: boundedText(afterId, 'after_id', 200) } : {}) })
        } else if (route === '/search') {
          const query = boundedText(url.searchParams.get('q'), 'query')
          const generationId = url.searchParams.get('generationId')
          result = generationId ? await hooks.search({ ...scope, query, generationId: boundedText(generationId, 'generation_id', 200) }) : { status: 'not_indexed', hits: [] }
        } else if (route === '/source') {
          source(res, req, await hooks.getSource({ ...scope, documentId: boundedText(url.searchParams.get('documentId'), 'document_id', 200) }))
          return true
        } else if (route === '/span') {
          result = await hooks.getSpan({ ...scope, spanId: boundedText(url.searchParams.get('spanId'), 'span_id', 200), generationId: boundedText(url.searchParams.get('generationId'), 'generation_id', 200) })
          if (!result) throw problem(404, 'span_not_found')
        } else if (route === '/operations') {
          result = await hooks.getOperation({ ...scope, operationId: boundedText(url.searchParams.get('operationId'), 'operation_id', 200) })
          if (!result) throw problem(404, 'operation_not_found')
        } else if (route === '/import') {
          if (!object(body.manifest)) throw problem(400, 'invalid_manifest')
          result = await hooks.importSources({ ...scope, manifest: body.manifest })
        } else result = await hooks.buildIndex(scope)
        json(res, writes.includes(route) ? 202 : 200, result)
      } catch (cause) {
        // Never forward arbitrary service messages, filesystem paths, or stacks.
        const status = [400, 404, 405, 413, 415].includes(cause?.status) ? cause.status : 500
        const code = status === 500 ? 'literature_service_error' : cause.code
        json(res, status, { error: { code, message: status === 500 ? 'The literature request failed.' : 'The literature request is unavailable or invalid.' } })
      }
      return true
    },
  }
}
