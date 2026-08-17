# qa-kernel

Local, evidence-first AI QA CLI for non-production B2B environments. Playwright produces facts and artifacts; Pi selects browser actions and returns an evidence-backed product verdict.

## Requirements

- Bun `1.3.14`
- Playwright Chromium: `bunx playwright install chromium`
- A non-production target explicitly allowlisted by `QA_ALLOWED_ORIGINS`
- A `QA_MODEL_API_KEY` for one approved provider/model configuration

Copy `.env.example` to `.env` and load it in your shell. Credentials are never passed to the model; the model can only name an allowlisted environment key in `browser.fill({ from })`.

## Model configuration

The default is OpenRouter GLM 5.2:

```bash
export QA_MODEL_PROVIDER=openrouter
export QA_MODEL_ID=z-ai/glm-5.2
export QA_MODEL_API_KEY='...'
```

For direct Anthropic:

```bash
export QA_MODEL_PROVIDER=anthropic
export QA_MODEL_ID=claude-opus-4-8
export QA_MODEL_API_KEY='...'
```

The allowlist also permits direct Anthropic `anthropic/claude-opus-4-8` and OpenRouter `openrouter/anthropic/claude-opus-4.8`. Set both `QA_MODEL_PROVIDER` and `QA_MODEL_ID` to one of those exact pairs; arbitrary routing and model IDs are rejected. OpenRouter requests pin the upstream to `z-ai` for GLM or `anthropic` for Opus, disable fallback providers, and require every requested parameter to be supported. Never commit a real key.

## Commands

```bash
bun run fixture
bun run qa validate --pack packs/fixture-smoke
bun run qa discover --url "$TARGET_URL" --mission "Check sign-in and cabinet navigation" --out packs/fixture-smoke/drafts
# Manually review and move approved YAML from drafts/ to cases/
bun run qa run --pack packs/fixture-smoke --out .qa/runs/local-fixture
bun run qa codegen --run .qa/runs/local-fixture --out packs/fixture-smoke/specs
bun run qa replay --pack packs/fixture-smoke --repeat 10
bun run qa report --run .qa/runs/local-fixture
```

The workflow has three explicit phases:

1. **Model-driven recording (`qa run`)**: the approved YAML case runs once with Pi. The host writes `recording.ndjson`, immutable `pack.yaml`/case copies, evidence, verdicts, and host-owned `codegenReadiness`.
2. **Deterministic codegen (`qa codegen`)**: a PASS case with complete grounded typed checks becomes `packs/<pack>/specs/<caseId>.spec.ts`. Codegen uses no model, CSS/XPath fallback, or kernel runtime import. Existing specs require `--force` to replace.
3. **Model-free replay (`qa replay`)**: local Playwright Test executes generated specs without reading YAML/recording and without `QA_MODEL_API_KEY`. Playwright owns pass/fail, report, trace, and failure screenshots.

`qa replay` does not diagnose or heal a failure. Diagnose/heal, mutations, cleanup, iframes, cross-origin flows, network assertions, and CRUD remain future stages.

For the same recording loop without assembling flags, `bun run tui` is a local menu over `validate` / `discover` / `run` / `report`; codegen and replay remain explicit commands.

`run` creates a new browser context and isolated Pi session per case. `report` reads only saved `results.json`; it does not invoke a model.

The fixture pack intentionally contains one known PASS (`FIXTURE-001`, valid sign-in) and one known FAIL (`FIXTURE-002`, reports return HTTP 500). The live model acceptance gate requires a configured provider key; codegen/replay acceptance can run from a synthetic or host-owned recording without a model key.

## Safety contract

- Only `safety.mutation: none` is accepted.
- Target and browser-network origins must be explicitly allowlisted.
- The only active Pi tool is `browser`; filesystem, shell, extensions, skills, prompts, and persisted sessions are disabled.
- Each action records before/after screenshot and snapshot evidence plus eligible safe network facts.
- Artifact strings and credential screenshots are redacted. Request/response headers, cookies, bodies, queries, and resolved secrets are not persisted.
- A model claim must cite evidence belonging to its current case and semantic step.

Exit codes: `0` all PASS, `1` at least one FAIL/BLOCKED/INCONCLUSIVE, `2` CASE_ERROR or run ERROR, `130` user cancellation.
