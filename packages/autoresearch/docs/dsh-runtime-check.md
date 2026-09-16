# DSH runtime preflight

The AutoResearch preset names plugins that must be importable by the DSH process that will consume it. Validate that specific installation before starting the host:

```sh
npm run check:dsh -- --dsh-package /absolute/path/to/node_modules/@deepseek-ai/dsh/package.json
```

The path must be absolute. The checker reads the bundled `auto-research` preset, walks plugin rows inside nested Cordis groups, skips Cordis builtins and rows with the literal `disabled: true`, and checks tagged disabled expressions without evaluating them. Each plugin is imported by a separate Node ESM process whose working directory is the selected DSH package directory. This preserves `import` conditions and package subpath exports and keeps resolution tied to the selected host instead of this package's development dependencies.

The output lists the Node and DSH CLI versions plus installed core runtime package versions it can read. A successful result means the preset's enabled or uncertain plugin specifiers imported. It does not mean Cordis mounted the preset, created a session, loaded a workspace, or completed a model call.

You can require the same preflight before installation changes profile or preset files:

```sh
npm run install:dsh -- web --dsh-package /absolute/path/to/node_modules/@deepseek-ai/dsh/package.json
```

Without `--dsh-package`, the installer only copies local configuration. It reports that runtime validation remains required and prints the checker command. This offline mode does not inspect or modify a global DSH installation.

If a failure names a transitive peer, repair that package in the host installation that owns the selected `dsh/package.json`. Use the exact version compatible with the surrounding DSH release; for the observed `0.1.5` release-candidate deployment, the missing workflow peer was repaired with `@deepseek-ai/dsh-workflow@0.1.5-rc.2`. Preserve the host's existing manifest and lockfile and add only the confirmed dependency. Do not broadly upgrade the DSH package family to make versions look uniform: release-candidate and alpha package versions may coexist, and the version report is evidence for reviewing that drift rather than a request to rewrite it.

After repair, rerun the checker against the same absolute path. Deployment acceptance still requires mounting the preset in the real profile and successfully creating a real session that loads the paper workspace. Keep that mount/session result separate from the import check in deployment records.
