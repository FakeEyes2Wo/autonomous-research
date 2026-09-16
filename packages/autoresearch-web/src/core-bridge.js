/**
 * Resolve the one settings implementation used by CLI, tools and Web. The
 * optional web package can also run in a DSH process that injects the service
 * directly, but it never implements a second filesystem writer.
 */
export async function resolveSettingsService(ctx) {
  const injected = typeof ctx?.get === 'function' ? ctx.get('autoresearchSettings') : ctx?.autoresearchSettings;
  if (injected && typeof injected.readProjectSettingsDocument === 'function') return injected;
  try {
    const core = await import('@athena/autoresearch/settings');
    const validate = core.validateProjectSettingsCandidate ?? core.validateProjectSettings;
    if (typeof core.readProjectSettingsDocument !== 'function' || typeof validate !== 'function' || typeof core.patchProjectSettingsDocument !== 'function') return undefined;
    return {
      readProjectSettingsDocument: async ({ root }) => {
        const result = await core.readProjectSettingsDocument(root);
        return { revision: result.revision, document: result.document ?? result.settings };
      },
      validateProjectSettingsCandidate: async ({ candidate }) => validate(candidate),
      patchProjectSettingsDocument: async ({ root, expectedRevision, operations }) => {
        const result = await core.patchProjectSettingsDocument(root, {
          expectedRevision,
          ops: operations.map((operation) => ({ ...operation, path: toPointer(operation.path) }))
        });
        return { revision: result.revision, document: result.document ?? result.settings };
      }
    };
  } catch {
    return undefined;
  }
}

function toPointer(path) {
  if (path.startsWith('/')) return path;
  return `/${path.split('.').map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/** One instance owns asynchronous import/index operations for this host. */
export async function resolveLiteratureService(ctx) {
  const injected = typeof ctx?.get === 'function' ? ctx.get('autoresearchLiterature') : ctx?.autoresearchLiterature;
  const methods = ['listPapers', 'search', 'getSource', 'getSpan', 'importSources', 'buildIndex', 'getOperation'];
  let service = injected;
  if (!service) {
    try { const { LiteratureService } = await import('@athena/autoresearch/literature'); service = new LiteratureService(); }
    catch { return undefined; }
  }
  if (methods.some(method => typeof service[method] !== 'function')) return undefined;
  return Object.fromEntries(methods.map(method => [method, service[method].bind(service)]));
}
