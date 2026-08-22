import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBibEntries, resolvePdfCandidates, safeFileName, downloadReferencePdfs } from '../../dist/paper/references.js'

const sampleBib = `@article{ren2024learning,
  author = {Yi Ren and Danica J. Sutherland},
  title = {Learning Dynamics of LLM Finetuning},
  journal = {ICLR},
  year = {2025},
  eprint = {2407.10490},
  archiveprefix = {arXiv},
  primaryclass = {cs.LG}
}

@inproceedings{rafailov2023dpo,
  title = {Direct Preference Optimization},
  author = {Rafael Rafailov and others},
  booktitle = {NeurIPS},
  year = {2023},
  doi = {10.48550/arXiv.2305.18290},
  url = {https://arxiv.org/abs/2305.18290}
}
`

test('parseBibEntries extracts keys and fields', () => {
  const entries = parseBibEntries(sampleBib)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.key, 'ren2024learning')
  assert.equal(entries[0]?.fields.eprint, '2407.10490')
  assert.equal(entries[1]?.key, 'rafailov2023dpo')
  assert.equal(entries[1]?.fields.doi, '10.48550/arXiv.2305.18290')
})

test('resolvePdfCandidates returns arXiv and DOI candidates', () => {
  const entries = parseBibEntries(sampleBib)
  const arxivCandidates = resolvePdfCandidates(entries[0]!)
  assert.ok(arxivCandidates.includes('https://arxiv.org/pdf/2407.10490'))
  const doiCandidates = resolvePdfCandidates(entries[1]!)
  assert.ok(doiCandidates.some((url) => url.startsWith('https://doi.org/')))
  assert.ok(doiCandidates.includes('https://arxiv.org/pdf/2305.18290'))
})

test('safeFileName sanitizes BibTeX keys', () => {
  assert.equal(safeFileName('Key/With Spaces:'), 'Key_With_Spaces')
  assert.equal(safeFileName('...'), 'ref')
})

test('downloadReferencePdfs writes an empty manifest without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-refs-'))
  try {
    const records = await downloadReferencePdfs(dir, '', { strict: false })
    assert.deepEqual(records, [])
    const manifest = JSON.parse(await readFile(join(dir, 'evidence', 'citations.json'), 'utf8'))
    assert.equal(manifest.schema, 'autoresearch/citation-pdfs/v1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('downloadReferencePdfs fails in strict mode when a reference has no PDF source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ar-refs-strict-'))
  try {
    await assert.rejects(
      downloadReferencePdfs(dir, '@article{noUrl,\n  title={No URL}\n}\n', { strict: true }),
      /failed to download PDFs for references: noUrl/,
    )
    const manifest = JSON.parse(await readFile(join(dir, 'evidence', 'citations.json'), 'utf8'))
    assert.equal(manifest.entries[0]?.status, 'failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
