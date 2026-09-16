# DSH upgrade record

- Anchor: `0.1.5-alpha.1` (the requested `dsh-v0.1.5-alpha.1` release).
- Installed CLI/package location: the active global `@deepseek-ai/dsh` package; no repository package is coupled to that installation path.
- Historical execution boundary: the alpha.1 upgrade and an early `--version`/help/diagnostic sequence did touch the real default DSH home. The settings document hash was unchanged, but the Web profile metadata was rewritten (including `patchReload: live`) and the credentials format migration ran. No model request, login, or deliberate termination of an existing user process was performed.
- Credential safety notice: an API-key-class credential was present in an earlier tool output during that incident. Its value and identifier are intentionally not recorded here. Rotate the affected API key. Without an old credentials-content backup, the original value cannot be independently verified; a successful migration must not be inferred merely from file presence.
- Subsequent compatibility checks used a temporary `DSH_HOME` only. They did not replace the historical real-home effects above and must not be described as a rollback or migration proof.
- Web compatibility: `@athena/autoresearch-web` targets the public `@deepseek-ai/dsh-client-ui-slots@0.1.5-alpha.1` contract and does not use a personal absolute module path.
- Loader boundary: the alpha.1 CLI/app-boot packages expose backend `dsh.bundle` profile loading; no public browser-graph Loader was available in the inspected package exports. The repository therefore verifies the `dsh.client` manifest contract and a temporary Cordis/SlotCore host, but does not claim a real profile/client-graph deployment.
- Risk note: existing DSH sessions should be restarted only according to the DSH release migration guidance. Do not treat a bare npm downgrade as a complete rollback for upgraded Session V3 data; retain a user-owned session snapshot if rollback is required.
