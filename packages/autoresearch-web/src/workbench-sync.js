// Recheck after fetching: the user may have typed or changed projects.
export function samePdfLoadTarget(pending, target) {
  return Boolean(pending && target) && pending.generation === target.generation &&
    pending.projectId === target.projectId && pending.documentId === target.documentId &&
    pending.version === target.version;
}

export function decideSync(snapshot, current, remote) {
  if (current.busy || snapshot.generation !== current.generation ||
      snapshot.projectId !== current.projectId || snapshot.documentId !== current.documentId ||
      remote.id !== current.documentId) return 'ignore';
  if (remote.revision !== current.revision) return current.dirty ? 'conflict' : 'apply';
  const target = remote.pdf ? { generation: snapshot.generation, projectId: snapshot.projectId, documentId: snapshot.documentId, version: remote.pdf.version ?? null } : null;
  if (samePdfLoadTarget(current.pdfPending, target)) return 'ignore';
  if ((remote.pdf?.version ?? null) !== (current.pdfVersion ?? null)) return 'preview';
  return 'unchanged';
}
