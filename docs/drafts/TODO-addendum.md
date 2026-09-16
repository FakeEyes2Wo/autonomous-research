# Additional pending work

These remain TODO and are not represented as complete capabilities:

- [x] Keep the CPA configuration adapter, safe installer and `nativeConfig` mapping optional and covered by mock/nativeConfig tests.
- [ ] Validate the real CPA/CLI Proxy model request with a user-selected local configuration; no request is made by this verification.
- [ ] Add and validate the Claude provider adapter using the same role/routing contract.
- [ ] Connect semantic escalation signals (`escalateOn`) to runtime quality evidence; `escalateTo` alone is only a declaration.
- [ ] Validate request-level hidden retry limits and duplicate-dispatch behavior through native runtime hooks.
- [ ] Add an explicit reviewed run-budget adjustment/recovery entry point. A project settings edit must not retroactively add tokens to an existing run, and `resume` must not clear `budget_exhausted` by itself.
- [ ] Complete the PDF/LaTeX PDF reader and artifact preview described in [TODO.md](TODO.md).

Do not close these items based only on schema, UI, mock-provider, or SlotCore
tests.
