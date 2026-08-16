# qa-kernel — план MVP AI QA-инженера

## 1. Что строим

`qa-kernel` — локальный CLI, который действует как QA-инженер на живом B2B-стенде:

1. получает URL, mission и ссылки на credentials из env;
2. самостоятельно исследует нужный участок продукта;
3. предлагает 2–3 смысловых test cases;
4. после ручного approve выполняет каждый case моделью в реальном Chromium;
5. выносит `PASS | FAIL | BLOCKED | INCONCLUSIVE`;
6. прикладывает конкретные screenshot, snapshot и network evidence к каждому выводу;
7. механически считает общий результат из сохранённых case results.

Playwright — руки и источник фактов. Модель — голова: выбирает действия, понимает увиденное и формулирует verdict. Host гарантирует, что evidence существует, относится к нужному кейсу и не содержит секретов.

Sibling-репозиторий: `/Users/integratorivan/Projects/qa-kernel`.

`tapgame-qa-pr` не изменяем и не используем как runtime-зависимость. OMP нет.

## 2. Гипотеза MVP

Если дать системе тестовый B2B-стенд и mission «проверь логин и основные разделы кабинета», она должна:

- исследовать этот участок сайта;
- предложить небольшое число grounded cases;
- после approve выполнить их в изолированных сессиях;
- не перепутать дефект продукта, ограничение рук и недогруженную страницу;
- выдать вывод без неподтверждённых утверждений: пользователь открывает evidence и видит, откуда взялся verdict.

Если это не работает на одном реальном стенде, replay, UI и большая regression-платформа продукт не спасут.

## 3. Неподвижные решения

- Модель находится внутри `qa run`, а не только в discovery.
- Модель может адаптировать способ прохождения, но не меняет утверждённые goal и oracle.
- Host выдаёт evidence IDs. Модель только выбирает существующие IDs текущего кейса.
- Счётчики и общий итог не берутся из свободного текста модели.
- Секреты не входят в prompt, tool result, network log и артефакты.
- Один case = новый BrowserContext + новая Pi session.
- Первый MVP поддерживает только `safety.mutation: none`.
- Человек approve-ит запуск кейса. Это не автоматическая гарантия качества oracle.
- `qa validate` проверяет схему и безопасность, но не понимает бизнес-смысл.

## 4. Границы MVP

### Входит

- Bun + TypeScript CLI;
- Playwright Chromium;
- Pi SDK `@earendil-works/pi-coding-agent`;
- AI discovery;
- semantic YAML cases;
- AI execution каждого approved case;
- screenshot, snapshot и безопасная сеть по действиям;
- JSON/NDJSON artifacts и Markdown report;
- безопасные credentials из env;
- `Ctrl+C` без zombie Chromium;
- локальный fixture-site;
- один read-only B2B acceptance pack.

### Не входит

- web UI, БД, проекты, ACL, issues и SSE;
- параллельные runs;
- scheduler и CI;
- mutations и cleanup;
- pixel-perfect, visual diff и Lighthouse;
- production-стенды;
- автоматический approve;
- `qa replay` и `qa heal`;
- попытка покрыть весь продукт.

## 5. Команды

```bash
qa discover \
  --url "$TARGET_URL" \
  --mission "Проверить логин и основные разделы кабинета" \
  --out packs/b2b-smoke/drafts

qa validate --pack packs/b2b-smoke

qa run \
  --pack packs/b2b-smoke \
  --out .qa/runs/<run-id>

qa report --run .qa/runs/<run-id>
```

- `discover` исследует сайт и создаёт drafts через host-validated structured output.
- Approve — ручное перемещение YAML из `drafts/` в `cases/`: «я согласен это запустить».
- `validate` проверяет pack до запуска модели и Chromium.
- `run` запускает AI отдельно на каждый approved case.
- `report` не вызывает модель и читает только сохранённые results.

## 6. Pack и semantic case

```text
packs/b2b-smoke/
  pack.yaml
  drafts/
    B2B-001.yaml
  cases/
    B2B-002.yaml
```

```yaml
# pack.yaml
schemaVersion: 1
id: b2b-smoke
name: B2B smoke
baseUrlFrom: TARGET_URL
allowedOriginsFrom: QA_ALLOWED_ORIGINS
allowedSecretRefs:
  - QA_EMAIL
  - QA_PASSWORD
```

```yaml
# cases/B2B-001.yaml
schemaVersion: 1
id: B2B-001
title: Пользователь входит в кабинет
goal: Проверить доступ зарегистрированного пользователя к кабинету

preconditions:
  - Пользователь не авторизован

data:
  emailFrom: QA_EMAIL
  passwordFrom: QA_PASSWORD

steps:
  - id: open-login
    instruction: Открыть страницу входа
  - id: fill-credentials
    instruction: Ввести валидные тестовые credentials
  - id: submit-login
    instruction: Отправить форму

oracle:
  source: product-requirement
  expect:
    - Пользователь попал в авторизованный кабинет
    - Интерфейс показывает авторизованное состояние
    - Запрос авторизации завершился успешно
  reject:
    - Пользователь остался на форме без объяснения
    - Показана ошибка авторизации
    - Кабинет открылся с ошибкой или пустым экраном

safety:
  mutation: none
```

Oracle остаётся простым текстовым контрактом. В MVP нет `confirmed/refuted/not-observed` на каждый критерий и нет host-пересчёта смысла verdict.

Допустимые `oracle.source`:

- `product-requirement`;
- `user-approved`;
- `qa-heuristic`;
- `baseline`;
- `inferred` — явно показывает, что это предположение модели.

Текущее поведение сайта само по себе не становится ожидаемым.

## 7. Браузерные руки

Модели доступен один custom tool `browser`:

- `open`;
- `snapshot`;
- `click`;
- `fill`;
- `press`;
- `scroll`;
- `screenshot`;
- `close`.

Builtin tools Pi выключены. CSS/XPath модели не передаём.

### 7.1 Snapshot: полезные глаза с потолком

Snapshot возвращает изображение и компактную структуру:

```ts
type Observation = {
  snapshotId: string;
  screenshotId: string;
  url: string;
  visibleText: string;
  aria: string;
  interactive: InteractiveTarget[];
  interactiveTruncated: boolean;
  omittedCount: number;
};

type InteractiveTarget = {
  ref: string;
  kind: "button" | "link" | "input" | "icon-control" | "clickable";
  name: string;
  nameSource: "aria" | "label" | "title" | "placeholder" | "nearby-header" | "nearby-text";
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
};
```

Правила выборки:

1. Только видимые элементы текущего viewport.
2. Жёсткий максимум — **60 interactive targets на snapshot**.
3. Приоритет 1: semantic controls с непустым accessible name.
4. Приоритет 2: подписанные inputs/links/buttons и focusable controls с понятным именем.
5. Приоритет 3: иконка с кликабельным предком рядом с label или заголовком колонки, например `Код товара — поиск`.
6. Внутри повторяющегося table/list-region — максимум 20 targets; controls заголовка выше controls строк.
7. Не включаем сырой SVG, каждую `td/tr` и любой `cursor:pointer` без имени или локального контекста.
8. Если кандидатов больше лимита, snapshot сообщает `interactiveTruncated` и `omittedCount`, а не молча режет данные.

Таким образом, WineLab-лупа у заголовка попадает в snapshot, а сотни кликабельных ячеек — нет.

Refs принадлежат конкретной версии snapshot. После navigation, DOM update или `scroll` они протухают. `scroll` страницы или контейнера всегда возвращает свежий Observation.

Обязательные before/after screenshot и snapshot снимает host автоматически. Явный `screenshot` нужен только для дополнительной разведки.

### 7.2 Действие и ожидание результата

Network ledger живёт весь BrowserContext. Слушатели не создаются и не снимаются вокруг каждого клика.

Для `click`, `fill` и `press` host делает:

```text
before snapshot + screenshot
→ поставить action watermark
→ выполнить действие
→ собрать eligible requests после watermark
→ bounded settle
→ дождаться DOM quiet
→ after snapshot + screenshot
→ вернуть ActionResult
```

Точное правило eligible request:

- request начался после watermark и не позднее **1500 ms** после завершения Playwright action;
- resource type: `document | xhr | fetch`;
- origin входит в allowed origins;
- исключены websocket, EventSource, static assets, analytics/telemetry denylist и prefetch;
- request, начавшийся позже окна, не приписывается этому action.

Settling:

- если eligible requests появились — ждём их завершения, но не более **8000 ms** от watermark;
- если requests не появились — ждём **300 ms DOM quiet**, но не дольше окна 1500 ms;
- после завершения requests ждём ещё **300 ms DOM quiet**;
- polling и long-lived requests не удерживают действие;
- `networkidle` не используется;
- timeout даёт `observationStatus: incomplete`, а не продуктовый FAIL.

Analytics или prefetch могут попасть в общий ledger как диагностический факт, но не участвуют в settle.

```ts
type ActionResult = {
  actionId: string;
  actionStatus: "ok" | "failed";
  observationStatus: "complete" | "incomplete" | "failed";
  beforeEvidenceIds: string[];
  afterEvidenceIds: string[];
  networkEvidenceIds: string[];
  observation: Observation | null;
  warnings: string[];
  error: { code: string; message: string } | null;
};
```

Сбой дополнительного screenshot не превращает успешный click в «действие не выполнено».

### 7.3 Безопасная сеть

Сохраняем только:

- method;
- origin + path без query/hash;
- status;
- resource type;
- duration;
- safe error.

Request/response headers, cookies и bodies не записываем.

### 7.4 Credentials

Секретное значение вводится только так:

```ts
browser.fill({ ref: "password-field", from: "QA_PASSWORD" })
```

Модель видит только имя allowlisted env key. Host читает значение непосредственно перед Playwright `fill` и не возвращает его модели.

Обычный `value` разрешён только для несекретных тестовых данных. Общий redactor заменяет известные secret values перед любой записью в prompt dump, events, snapshot, report или console.

## 8. Evidence

Evidence ID выдаёт host только после успешной регистрации артефакта:

```ts
type Evidence = {
  id: string;
  caseId: string;
  stepId: string;
  actionOrdinal: number;
  phase: "before" | "after";
  kind: "screenshot" | "snapshot" | "network";
  url: string;
  createdAt: string;
  hash: string;
};
```

После каждого action модель получает evidence manifest только текущего case. Host автоматически регистрирует все action evidence; модель выбирает релевантные IDs для своих утверждений.

Result содержит утверждения, а не criterion state machine:

```json
{
  "schemaVersion": 1,
  "testCaseId": "B2B-001",
  "executionStatus": "completed",
  "verdict": "FAIL",
  "blockedBy": null,
  "actual": "После отправки формы пользователь остался на странице входа без сообщения",
  "evidence": [
    {
      "stepId": "submit-login",
      "claim": "Форма осталась открыта, сообщение об ошибке отсутствует",
      "evidenceIds": ["ev-screen-after", "ev-auth-response"]
    }
  ],
  "reviewReason": null,
  "error": null
}
```

Host проверяет только проверяемую механику:

- evidence ID существует;
- evidence принадлежит этому case;
- evidence относится к указанному step;
- файл действительно записан и hash совпадает;
- обязательные поля статуса заполнены.

Host не пересчитывает смысловой verdict из набора мини-критериев. Это работа модели. Если модель прикрутила скрин другого шага, result невалиден.

## 9. Статусы и локальные ошибки

### Product verdict

- `PASS` — ожидаемое поведение подтверждено evidence;
- `FAIL` — наблюдается конкретное нарушение oracle;
- `BLOCKED` — case нельзя выполнить; обязателен `blockedBy`;
- `INCONCLUSIVE` — фактов недостаточно для честного PASS/FAIL; обязателен `reviewReason`.

`blockedBy`:

- `capability` — руки не видят или не умеют нужный control;
- `credentials` — отсутствует доступ;
- `environment` — стенд, сеть или внешняя зависимость;
- `safety` — действие запрещено pack;
- `product` — ожидаемый экран или flow отсутствует.

### Case execution

- `completed` — модель вернула валидный product verdict;
- `error` — case технически не завершён, `verdict: null`.

Если structured result невалиден, host один раз просит модель исправить JSON **без новых browser actions**. Повторная ошибка даёт этому case `executionStatus: error`. Следующий case всё равно запускается.

### Run status

- `COMPLETED` — все cases были попытаны; внутри могут быть product verdicts и локальные case errors;
- `ERROR` — pack нельзя продолжить из-за общей configuration/browser/artifact/model infrastructure;
- `ABORTED` — пользователь отменил run.

Summary содержит отдельные counts:

```text
PASS / FAIL / BLOCKED / INCONCLUSIVE / CASE_ERROR
```

Они вычисляются из сохранённых case results. Текст модели не является источником чисел.

Exit codes:

- `0` — все cases завершились `PASS`;
- `1` — есть `FAIL`, `BLOCKED` или `INCONCLUSIVE`;
- `2` — есть `CASE_ERROR` или общий run `ERROR`;
- `130` — отмена пользователем.

## 10. Лимиты модели

Константы MVP:

- максимум **25 browser actions на case**;
- максимум **5 минут на case**;
- максимум одна попытка repair structured result;
- три подряд одинаковых Observation без изменения URL, visible text, interactive refs или сети считаются отсутствием прогресса.

При лимите действий или отсутствии прогресса модель должна завершить case как `BLOCKED` либо `INCONCLUSIVE`. Если валидный result не получен, это локальный `CASE_ERROR`.

Token usage, длительность и число actions пишутся в `meta.json`, но не влияют на product verdict.

## 11. Discovery

`qa discover`:

1. проверяет env и allowed origins;
2. запускает чистую Pi session с единственным browser tool;
3. посещает только реально доступные области mission;
4. сохраняет карту увиденного и explicit uncovered areas;
5. предлагает 2–3 неповторяющихся cases;
6. формулирует oracle до отдельного `qa run`;
7. возвращает structured result, который host сериализует в YAML.

Статус draft:

- `ready` — ключевое взаимодействие действительно удалось выполнить во время discovery;
- `needsCapability` — модель визуально увидела нужный control, запросила свежий snapshot/scroll и попыталась действовать, но руки не дали пригодный ref;
- неподтверждённая фантазия о неувиденной функции вообще не записывается как draft.

`needsCapability` — диагностический результат, а не главный способ обеспечить качество глаз. Главный гейт — WineLab-like fixture с иконкой у заголовка колонки до реализации discovery.

Модель не получает filesystem tools и не пишет YAML напрямую. Один и тот же search/filter control не должен порождать несколько почти одинаковых drafts.

## 12. AI execution

`qa run`:

1. валидирует pack до запуска Chromium;
2. сохраняет immutable copy approved cases в run artifacts;
3. запускает один Chromium;
4. для каждого case создаёт новый BrowserContext и Pi session;
5. передаёт модели frozen goal, steps, oracle и browser tool;
6. автоматически собирает before/after/network evidence;
7. принимает structured result и при необходимости делает один repair;
8. сохраняет completed result или локальный case error;
9. закрывает context и продолжает следующий case;
10. строит summary механически.

Модель может выбрать другой путь по UI, но не может расширить origins, tools, env refs или safety.

## 13. Изоляция Pi

- Использовать SDK, не `pi` CLI и не `@oh-my-pi/*`.
- Exact SDK version и model ID закрепить после compatibility spike.
- Builtin tools выключить; доступен только custom `browser`.
- Не загружать `~/.pi`, workspace `AGENTS.md`, skills, extensions, prompts и сохранённые sessions.
- Использовать in-memory settings/session и пустой resource loader.
- Перед каждым запуском проверять фактический список active tools.
- Model fallback отсутствует: недоступная pinned model — configuration error.
- Package/model versions сохраняются в `meta.json`.

## 14. Артефакты

```text
.qa/
  discoveries/<id>/
    meta.json
    events.ndjson
    evidence.ndjson
    network.ndjson
    screenshots/
    snapshots/
    product-map.yaml
    result.json

  runs/<id>/
    meta.json
    cases/
    events.ndjson
    evidence.ndjson
    network.ndjson
    screenshots/
    snapshots/
    results.json
    report.md
```

- `.qa/` находится в `.gitignore`.
- NDJSON дописывается после каждого события.
- JSON пишется через temporary file + atomic rename.
- `results.json` обновляется после каждого case.
- `evidence.ndjson` — host-owned индекс связи case/step/action/phase/file.
- `meta.json` содержит версии, target origin, timings, token usage и action counts.
- Query, headers, bodies и resolved credentials не сохраняются.
- Report строится из `results.json`, без нового model prompt.

## 15. Cancel и безопасность

- Один `AbortController` проходит через model и browser operations.
- Первый `Ctrl+C` abort'ит текущую работу, закрывает context и Chromium, сохраняет partial artifacts и выходит с `130`.
- Повторный сигнал не ждёт graceful shutdown.
- Отмена не отправляется модели как просьба остановиться.
- Integration test проверяет отсутствие дочернего Chromium.
- Разрешены только явно указанные non-production origins.
- Единственное значение MVP — `safety.mutation: none`; остальные отклоняет `qa validate`.
- Контент страницы недоверенный и не может менять tools, oracle, origins или env refs.

## 16. Минимальная архитектура

Достаточно семи модулей:

1. `cli` — команды и exit codes;
2. `schema` — pack/case/model result validation;
3. `browser` — Playwright, observations, settle и network ledger;
4. `evidence` — IDs, files, manifest и redaction;
5. `pi` — изолированная model session;
6. `discover` и `run` — два явных workflow;
7. `report` — механическая агрегация results.

Не создавать repository/service/framework layers, пока не появится реальная вторая реализация.

## 17. План реализации

### Этап 0. Compatibility spike и минимальный контракт

- [ ] Закрепить Bun, Playwright, Chromium, Pi SDK и model versions.
- [ ] Запустить Pi session только с custom `browser` stub.
- [ ] Доказать отсутствие builtin tools и resource discovery.
- [ ] Зафиксировать минимальные pack/case/result schemas и exit codes.

Готово, когда модель вызывает только browser stub и host валидирует два example cases. Не строим полный schema framework.

### Этап 1. Walking skeleton с живым Chromium

- [ ] Инициализировать Bun + TypeScript, `bin/qa`, test и typecheck.
- [ ] Добавить fixture-site.
- [ ] Реализовать Chromium lifecycle и `open/snapshot/screenshot/close`.
- [ ] Сохранить первый screenshot, snapshot и `meta.json` через CLI.
- [ ] Добавить `.env.example`, `.gitignore` и README.

Готово, когда `qa run` без модели открывает fixture и сохраняет реальные артефакты. Chromium появляется сразу, а не после нескольких этапов схем.

### Этап 2. Полные руки, evidence и безопасность

- [ ] Реализовать `click/fill/press/scroll`.
- [ ] Реализовать snapshot priority и hard cap 60.
- [ ] Реализовать session-long network ledger.
- [ ] Реализовать watermark, 1500 ms start window, 8000 ms deadline и DOM quiet.
- [ ] Разделить action и observation statuses.
- [ ] Реализовать host evidence manifest и проверку case/step IDs.
- [ ] Реализовать `fill(from)`, redactor и sentinel scan.
- [ ] Реализовать strict origin и `mutation: none` validation.

Обязательные fixture gates до модели и живого стенда:

1. Named semantic control находится и кликается.
2. WineLab-like лупа у заголовка колонки получает понятный ref.
3. Snapshot содержит не более 60 targets и не засасывает table cells/raw SVG.
4. Элемент ниже viewport находится после `scroll` со свежими refs.
5. XHR длительностью 2,5–3 секунды не даёт преждевременный verdict.
6. Analytics, prefetch и long-poll не удерживают action.
7. Evidence другого case/step отклоняется.
8. Sentinel secret отсутствует в tool results, events, network, console и `.qa/`.
9. Успешный click остаётся успешным при сбое дополнительного screenshot.

### Этап 3. Один AI-executed case

- [ ] Подключить isolated Pi session к browser tool.
- [ ] Передать один frozen case модели.
- [ ] Ввести лимит 25 actions / 5 минут / 3 одинаковых observations.
- [ ] Принять structured verdict с claim-level evidence.
- [ ] Реализовать один JSON repair без браузера.
- [ ] Сохранить completed result или локальный case error.

Готово, когда известный fixture PASS и известный fixture FAIL получают честные verdicts, а evidence действительно показывает нужный шаг.

### Этап 4. Discovery

- [ ] Реализовать product map и uncovered areas.
- [ ] Создавать 2–3 grounded drafts.
- [ ] Различать `ready` и доказанный `needsCapability`.
- [ ] Требовать oracle source и `mutation: none`.
- [ ] Писать YAML только после host validation.

Готово, когда drafts основаны на посещённых страницах, а WineLab-like icon case может стать `ready`, а не исчезает из-за ARIA-only глаз.

### Этап 5. Pack run и report

- [ ] Последовательно выполнить approved cases.
- [ ] Новый BrowserContext и Pi session на case.
- [ ] Продолжать pack после любого product verdict и локального `CASE_ERROR`.
- [ ] Обновлять `results.json` после каждого case.
- [ ] Считать `PASS/FAIL/BLOCKED/INCONCLUSIVE/CASE_ERROR` механически.
- [ ] Построить Markdown report без модели.

Готово, когда intentional mix всех статусов даёт точные counts и полный набор evidence.

### Этап 6. Cancel и crash safety

- [ ] Провести AbortSignal через Pi и Playwright.
- [ ] Реализовать SIGINT и exit `130`.
- [ ] Сделать JSON writes атомарными.
- [ ] Сохранить завершённые case results после cancel/crash.

Готово, когда `Ctrl+C` во время settle закрывает Chromium без zombie process.

### Этап 7. Живой B2B acceptance

- [ ] Выбрать non-production stand через `.env`, без hardcode.
- [ ] Mission: логин и 2–3 основных read-only раздела.
- [ ] Провести discovery.
- [ ] Прочитать drafts и approve минимум три cases.
- [ ] Выполнить pack три раза в свежих contexts.
- [ ] Вручную открыть evidence каждого verdict.

Acceptance:

- логин даёт один и тот же verdict `3/3`;
- остальные verdicts могут различаться, только если различие объясняется конкретным evidence;
- ни один продуктовый FAIL не основан только на loading state или tool error;
- ни один PASS не ссылается на evidence другого case/step;
- пользователь не видит неподтверждённых утверждений в report;
- summary совпадает с сохранёнными case results.

## 18. Тестовая стратегия

### Unit

- strict schemas и unknown fields;
- allowed origins и env allowlist;
- snapshot priority/cap;
- request eligibility classifier;
- action watermark и settle deadlines;
- evidence case/step validation;
- secret redaction;
- result aggregation и exit codes;
- repeated observation guard;
- atomic writer recovery.

### Integration fixture

- semantic button PASS;
- header icon без ARIA name;
- большая таблица без snapshot explosion;
- scroll-container;
- slow XHR;
- analytics/prefetch/long-poll;
- wrong evidence ID;
- sentinel credential;
- partial observation при успешном action;
- model JSON repair и локальный `CASE_ERROR`;
- продолжение следующего case;
- SIGINT без zombie Chromium.

### Live

- только non-production;
- только `mutation: none`;
- ручной approve перед run;
- ручное открытие evidence после run.

## 19. Definition of Done MVP

MVP готов, только когда одновременно выполнено:

- [ ] Все девять fixture gates этапа 2 проходят.
- [ ] `qa discover` создаёт 2–3 grounded drafts по живому стенду.
- [ ] `qa run` выполняет approved cases моделью в Chromium.
- [ ] Каждый claim результата ссылается на host evidence текущего case/step.
- [ ] Модель отличает продуктовый FAIL от incomplete observation и tool error.
- [ ] Invalid JSON одного case не останавливает pack.
- [ ] Counts совпадают с `results.json`, включая `CASE_ERROR`.
- [ ] Sentinel secret отсутствует во всех проверяемых output surfaces.
- [ ] `Ctrl+C` не оставляет Chromium.
- [ ] Живой логин стабилен `3/3`.
- [ ] Пользователь вручную открыл evidence живого pack и не нашёл неподтверждённых утверждений.
- [ ] В репозитории нет UI, DB, SSE, OMP, replay и mutation complexity.

## 20. После MVP

Только после Definition of Done:

1. `qa replay` для стабильных semantic cases;
2. `qa heal` как proposed patch replay target;
3. regression fingerprints;
4. HTML report;
5. CI и scheduled runs;
6. parallel execution;
7. mutations с явным cleanup contract;
8. UI/JokerQA-слой.
