# Python experiment code guidance

Apply this section only when Python is the selected language. For other languages, follow the repository's conventions; do not add Python as a requirement.

Follow the repository's selected Python tooling and dependency style; do not introduce a second formatter, test runner, or packaging system without need.

- Use explicit imports, portable `pathlib.Path` paths, and typing on public interfaces. Keep modules and functions small enough to express one scientific responsibility.
- Do not train, download, mutate data, or parse commands at import time. Put orchestration behind an explicit function or command entrypoint only when the experiment needs one.
- Validate external inputs and raise clear, actionable errors. Do not hide failures behind fabricated data, silent defaults, or broad exception handling.
- Make randomness, dataset/split selection, and hyperparameters configurable and record resolved values. Keep raw data immutable.
- Test high-risk scientific logic such as preprocessing, split integrity, metrics, and deterministic seed behavior. Not every file needs a test or `__main__`; choose checks that can catch a wrong scientific result.
