# `@athena/autoresearch-web`

Optional DSH Web surface for simple AutoResearch settings and a LaTeX/PDF research workbench.

Settings now show model source, research intensity and paper output by default;
advanced routing/workflow/budget controls are collapsed. Open the research
workbench from this section or the top-left native sidebar entry (`/?autoresearch=1`).
It retains the original DSH workspace sidebar, where one native workspace
directory is one research project. It places LaTeX and PDF above the native
conversation, and uses DSH theme tokens. The conversation has a small
outer margin and can be resized or collapsed. Research shortcuts populate the
native draft for the user to send; generated papers and external edits are
discovered without overwriting unsaved source drafts. See the
[conversation and portability guide](../../docs/drafts/2026-09-10-conversational-workbench-guide.md).

Clicking a workspace name only expands or collapses its session list. To move
the workbench to another research directory, open one of that workspace's
sessions or use the `+` action on its row. While the research workbench is
open, workspace-row and global new-session actions create a fresh AutoResearch
session in the selected native workspace; they do not reuse the remembered
conversation or the directory that was active previously.

The workbench uses Tectonic selected by `workbench.compiler`, `TECTONIC_PATH`,
or PATH. No machine-specific compiler path, mandatory local proxy or browser CDN
is built in. Editing and saving still work if Tectonic is unavailable.
PDF.js and its resources are copied into `dist/vendor/pdfjs` during the build.

The package registers one `settings.section` entry and a loopback, same-origin
API. It does not replace DSH Settings → Models: providers, CPA base URLs and
credentials remain owned by the native Models page. The AutoResearch page shows
three primary controls—model source, research intensity and paper output.
Advanced routing, workflow and budget declarations remain available in the
collapsed section.

The earlier DSH deployment record predates the workspace-managed workbench.
It does not verify the current native workspace/session integration.

## Host contract

In a native DSH host, the injected workspace registry is the only source of
research project directories. The iframe receives an opaque project ID from its
parent after `ready`; it never chooses a directory or submits a path. Selecting
another native workspace refreshes the registry, and selecting no workspace
clears the paper panel.

`projects` is retained only for an explicit standalone test host with no native
workspace registry. It must opt in with `standaloneProjects: true`:

```yaml
autoresearch-web:
  standaloneProjects: true
  projects:
    - id: thesis
      name: Challenge Cup thesis
      root: . # relative to the directory where DSH is launched
```

The host resolves and canonicalizes every native workspace root before exposing
its opaque ID to the browser. No request can submit a path. The host first uses an injected
`autoresearchSettings` service when present; otherwise it imports the core
package's `@athena/autoresearch/settings` entry point. That entry point must
export the shared direct functions:

```text
readProjectSettingsDocument(projectDir)
validateProjectSettingsCandidate(candidate) // or validateProjectSettings(candidate)
patchProjectSettingsDocument(projectDir, { expectedRevision, ops })
```

The bridge maps the core `settings` field to the transport `document` field and
converts the UI's dotted paths to JSON Pointer paths. If the core contract is unavailable the API returns `503
core_settings_service_unavailable` and performs no write. There is no fallback
file writer in this package.

## Browser bundle

`exports["./client"]` is a DSH lazy-factory bundle and declares `dsh.client`.
React and DSH services are host externals; this package does not bundle a second
React or settings shell. The browser does not persist keys or project roots.
The repository smoke test executes the factory with the installed DSH
`SlotCore`. Real Windows DSH profile rendering has also been verified; the
deployment record above describes the host version and scope.

The page reports that runtime token-budget enforcement is pending whenever the
core request hooks have not been verified. A saved budget declaration is not
shown as a successful hard limit.

Role `tier` selection is the supported way to choose a high-intelligence model
for a role. `escalateTo` is retained as an advanced declaration, but automatic
semantic escalation signals and `escalateOn` are not wired into the runtime yet;
the UI labels that capability as pending validation rather than implying that
it is active.

## Optional source-repository installation

This package is opt-in. The two packages are private source-repository
packages, not published npm artifacts. Build them, then add local links to the
target DSH profile's `package.json` (use a temporary profile first):

```sh
npm --prefix packages/autoresearch run build
npm --prefix packages/autoresearch-web install --ignore-scripts --legacy-peer-deps
npm --prefix packages/autoresearch-web run build
```

The Web package's local core development dependency is needed for source-link
installs: linking both packages into a profile alone does not make core imports
resolvable from the Web source directory. DSH service dependencies stay provided
by the host.

```json
{
  "dependencies": {
    "@athena/autoresearch": "link:C:/work/autonomous-research/packages/autoresearch",
    "@athena/autoresearch-web": "link:C:/work/autonomous-research/packages/autoresearch-web"
  }
}
```

Add the optional rows to that profile's `cordis.patch.yml`; this is native
Cordis composition, so the host calls the package `apply` and no user
JavaScript bootstrap is needed:

```yaml
- insert:
    - id: autoresearch
      name: '@athena/autoresearch'
    - id: autoresearch-web
      name: '@athena/autoresearch-web'
      inject: [webServer]
```

The production row does not register or select research directories. DSH's
native workspace registry supplies them. Add `standaloneProjects: true` and a
`projects` allowlist only in an explicit standalone test host that has no native
workspace registry; the earlier example in **Host contract** documents that
fallback.

After reviewing the allowlist, run the profile package manager in that profile
(for example `pnpm install`) and start DSH with that profile. The package's
public `inject: ['webServer']` declaration waits for the native web service;
the browser `dsh.client` manifest is consumed by the host's web composition.
The repository's Cordis/SlotCore and real local profile checks validate this
contract for DSH 0.1.5-alpha.1.

The native workspace registry supplies production directories; the standalone
allowlist is test-only. The browser cannot submit filesystem paths.
Installing/building this source package does not edit a DSH profile,
credentials, or the global settings file. Adding the rows is an explicit
profile change; back up the profile first and do not run it against a real
profile until the allowlist and shared settings service have been reviewed.
The host's DSH settings location is used as configured (the usual default is
`.dsh/settings.yaml`), while project settings remain owned by the core settings
service.
