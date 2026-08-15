# qa-kernel

Local, evidence-first AI QA CLI for non-production B2B environments. Playwright produces facts and artifacts; Pi selects browser actions and returns an evidence-backed product verdict.

## Requirements

- Bun `1.3.14`
- Playwright Chromium: `bunx playwright install chromium`
- A non-production target explicitly allowlisted by `QA_ALLOWED_ORIGINS`
- A credential for the pinned `anthropic/claude-opus-4-8` Pi model in `QA_PI_API_KEY`

Copy `.env.example` to `.env` and load it in your shell. Credentials are never passed to the model; the model can only name an allowlisted environment key in `browser.fill({ from })`.

## Commands

```bash
bun run fixture
bun run qa validate --pack packs/fixture-smoke
bun run qa discover --url "$TARGET_URL" --mission "Check sign-in and cabinet navigation" --out packs/fixture-smoke/drafts
# Manually review and move approved YAML from drafts/ to cases/
bun run qa run --pack packs/fixture-smoke --out .qa/runs/local-fixture
bun run qa report --run .qa/runs/local-fixture
```

`run` creates a new browser context and isolated Pi session per case. `report` reads only saved `results.json`; it does not invoke a model.

## Safety contract

- Only `safety.mutation: none` is accepted.
- Target and browser-network origins must be explicitly allowlisted.
- The only active Pi tool is `browser`; filesystem, shell, extensions, skills, prompts, and persisted sessions are disabled.
- Each action records before/after screenshot and snapshot evidence plus eligible safe network facts.
- Artifact strings and credential screenshots are redacted. Request/response headers, cookies, bodies, queries, and resolved secrets are not persisted.
- A model claim must cite evidence belonging to its current case and semantic step.

Exit codes: `0` all PASS, `1` at least one FAIL/BLOCKED/INCONCLUSIVE, `2` CASE_ERROR or run ERROR, `130` user cancellation.
