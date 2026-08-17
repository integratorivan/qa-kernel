

## QA Testing (Assrt)

**CRITICAL: You MUST run `assrt_test` after ANY user-facing change.** Do not wait for the user to ask. Do not skip this step. Do not consider a task complete until tests pass.

- **After every UI, route, form, or user flow change**: run `assrt_test` against the local dev server to verify it works in a real browser.
- **New features**: use `assrt_plan` to auto-generate test cases, then run them with `assrt_test`.
- **Bug fixes**: write a targeted `#Case` that reproduces the bug, run with `assrt_test`.
- **Failed tests**: use `assrt_diagnose` to understand root cause before attempting a fix. Do not guess.
