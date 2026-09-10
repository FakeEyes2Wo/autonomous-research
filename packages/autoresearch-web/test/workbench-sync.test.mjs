import assert from 'node:assert/strict';
import test from 'node:test';
import { decideSync, samePdfLoadTarget } from '../src/workbench-sync.js';

const snapshot = { generation: 1, projectId: 'p', documentId: 'd' };
const current = { ...snapshot, revision: 'old', pdfVersion: 'pdf1', dirty: false, busy: false };
const remote = { id: 'd', revision: 'new', pdf: { version: 'pdf2' } };
test('clean external edits are applied; unchanged documents stay untouched', () => {
  assert.equal(decideSync(snapshot, current, remote), 'apply');
  assert.equal(decideSync(snapshot, current, { ...remote, revision: 'old', pdf: { version: 'pdf1' } }), 'unchanged');
});
test('draft edits made while the fetch was in flight are protected', () => {
  assert.equal(decideSync(snapshot, { ...current, dirty: true }, remote), 'conflict');
  assert.equal(decideSync(snapshot, { ...current, busy: true }, remote), 'ignore');
});
test('stale responses from another document or project cannot apply', () => {
  for (const patch of [{ generation: 2 }, { projectId: 'elsewhere' }, { documentId: 'another' }]) {
    assert.equal(decideSync(snapshot, { ...current, ...patch }, remote), 'ignore');
  }
  assert.equal(decideSync(snapshot, current, { ...remote, id: 'another' }), 'ignore');
});
test('a PDF-only update can refresh without replacing an unsaved source', () => {
  assert.equal(decideSync(snapshot, { ...current, dirty: true }, { ...remote, revision: 'old' }), 'preview');
  assert.equal(decideSync(snapshot, current, { ...remote, revision: 'old' }), 'preview');
});
test('a poll does not restart a PDF whose version is already loading', () => {
  assert.equal(decideSync(snapshot, { ...current, pdfVersion: null, pdfPending: { generation: 1, projectId: 'p', documentId: 'd', version: 'pdf2', task: {} } }, { ...remote, revision: 'old' }), 'ignore');
});
test('PDF load identity requires the current generation, project, document and version', () => {
  const pending = { generation: 1, projectId: 'p', documentId: 'd', version: 'pdf2', task: {} };
  assert.equal(samePdfLoadTarget(pending, { generation: 1, projectId: 'p', documentId: 'd', version: 'pdf2' }), true);
  for (const key of ['generation', 'projectId', 'documentId', 'version']) {
    const changed = { generation: 1, projectId: 'p', documentId: 'd', version: 'pdf2' };
    changed[key] = key === 'generation' ? 2 : `${changed[key]}-other`;
    assert.equal(samePdfLoadTarget(pending, changed), false, `changed ${key} must invalidate the load`);
  }
});
