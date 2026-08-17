# Что берём у Assrt — и что нет

Assrt (продукт + `assrt-ai/assrt-mcp`) близок по слогану: агент ходит по вашему приложению и пишет тесты. Код MCP — не генератор Playwright-спек, а LLM-in-loop раннер (`assrt_plan` / `assrt_test` / `assrt_diagnose`) поверх Playwright MCP. Форка нет. Берём пять механик и встраиваем в host, не в промпт «как у них».

## Не берём

- MCP-сервер, shared browser session между кейсами, PostHog, cloud, `#Case` markdown.
- `assrt_plan` как замену `qa discover`. Их planner смотрит на страницу и пишет текстовые сценарии; у нас YAML + evidence + approve.
- Playwright Agents Planner / Playwright MCP Planner как фундамент. Он пишет план для *их* агента, не durable spec. Это тот же дорогой путь «модель на каждый nightly», от которого уходим.

## Берём сейчас (этот этап)

| # | У них | У нас | Зачем |
|---|--------|--------|--------|
| 1 | `PLAN_SYSTEM_PROMPT`: self-contained, конкретные контролы, короткие кейсы, только наблюдаемое | `DISCOVERY_INSTRUCTION` | Atlas-черновики теряли логин и писали «зайди в кабинет» |
| 2 | `preflightUrl` до `browser.launch` | `preflightUrl` в `qa discover` и `qa run` | wedged стенд не должен жечь 3 минуты Chromium+модель |
| 3 | snapshot truncate 120k | model-facing `aria` / `visibleText` cap; полный snapshot остаётся в evidence | Wikipedia-sized дерево не взрывает контекст |
| 4 | `droppedAssertions`: verify-bullet без assert → fail | host: PASS без покрытия `oracle.expect` → `INCONCLUSIVE` | модель не может сказать PASS, не адресуя oracle |
| 5 | `DIAGNOSE_SYSTEM_PROMPT` (app / test / environment) | контракт бакетов в `plan-codegen-replay.md`; команды `qa diagnose` ещё нет | пригодится на FAIL replay, не в Discover |

Пункты 1–4 реализованы в ядре. Пункт 5 — только контракт, до `qa replay`.

## Как именно в ядре

### 1. Discover prompt

Правила Assrt, переложенные на наш YAML:

- каждый draft самодостаточен (логин внутри кейса, если нужен);
- шаги называют видимый контрол, не маршрут;
- `oracle.expect` / `reject` — только то, что видно на экране, в URL или в сети;
- 3–7 шагов;
- не выдумывать зоны за логином, пока форма не пройдена в этой сессии;
- `ready` только после успешного click/fill/press.

Схема `discoveryJsonSchema` не меняется.

### 2. Preflight

`src/preflight.ts`: HEAD, при 405/501 — GET. Любой HTTP-статус = reachable. Fail только на DNS, connection refused, timeout. Не-http URL пропускаются. 8 секунд, до `BrowserController.start()`.

### 3. Truncate

Полный redacted snapshot пишется в evidence JSON. В Observation, который уходит модели, `aria` режется на 80k, `visibleText` на 30k, с флагами `ariaTruncated` / `visibleTextTruncated`. Refs в `interactive` не режутся — они уже capped (60 / 20).

### 4. Oracle coverage

Нет tool `assert`, поэтому покрытие считается по тексту `actual` + `evidence[].claim`. На PASS каждый `oracle.expect` должен разделить хотя бы одно содержательное слово (длина > 3, минус стоп-слова) с этим текстом. Иначе host меняет verdict на `INCONCLUSIVE` и пишет `oracle_coverage` в `events.ndjson`. FAIL / BLOCKED / INCONCLUSIVE не трогаем.

## Что сознательно позже

- Diagnose-бакеты как команда — после первого дешёвого replay.
- Coverage на `oracle.reject` при FAIL — легко ложные срабатывания, пока нет assert-tool.
- Их continuous page discovery и viewport presets.
