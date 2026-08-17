# Replay через генерацию Playwright

## 1. Результат этапа

После approve человек получает обычный Playwright `.spec.ts` и дальше запускает его без модели.

```text
discover → approve YAML → qa run (одна запись) → qa codegen → qa replay
```

Роли разделены жёстко:

- Discovery-агент исследует продукт и предлагает test cases;
- человек approve-ит смысл кейса;
- `qa run` один раз проходит approved-кейс моделью и записывает успешный исполнимый след;
- `qa codegen` детерминированно превращает этот след в TypeScript;
- `qa replay` запускает обычный Playwright Test без модели;
- при падении текущий этап сохраняет Playwright trace и screenshot, но ничего не лечит автоматически.

Конечный продуктовый артефакт — переносимый `.spec.ts`, а не YAML-runtime и не агент в nightly.

## 2. Отношение к текущему MVP

Текущий kernel уже умеет:

- `qa discover` → semantic YAML drafts;
- ручной approve draft в `cases/`;
- `qa run` approved pack моделью в реальном Chromium;
- сохранять `access.ndjson`, screenshots, snapshots, network evidence и `results.json`;
- изолировать BrowserContext и модельную сессию на case;
- не пропускать секреты в модель и артефакты;
- работать только с `safety.mutation: none`.

Этого недостаточно для честного codegen:

- `access.ndjson` содержит `ref`, но не стабильный locator;
- в нём нет несекретного `value`, клавиши, параметров scroll и source snapshot;
- `ref` живёт только в одной версии snapshot;
- свободный текст `oracle.expect` / `oracle.reject` не является Playwright assertion;
- model-facing snapshot ограничен и не должен становиться входом археологии для генератора.

Этот документ описывает следующий этап. Он не переписывает завершённые границы `PLAN.md` и не объявляет mutations/replay частью старого MVP.

## 3. Неподвижные решения

1. Codegen и replay не вызывают LLM.
2. Codegen принимает только approved case с завершённым `PASS`-run.
3. Codegen не читает Discover drafts.
4. Codegen не восстанавливает локаторы по `ref` и snapshot после run.
5. Host записывает готовый locator в момент выполнения действия.
6. Каждое сгенерированное assertion происходит из успешной typed check записи.
7. Если действие, locator или oracle нельзя скомпилировать однозначно, spec не создаётся.
8. Никаких CSS/XPath fallback и никаких придуманных `data-testid`.
9. Generated spec не импортирует `qa-kernel` и не читает `pack.yaml` в runtime.
10. После codegen `.spec.ts` — исполняемый канон replay. YAML хранит intent, recording — происхождение.
11. Существующий spec не перезаписывается без явного `--force`.
12. Первый срез работает только с `safety.mutation: none`.
13. Первый срез доказывается на локальном fixture, не на Atlas/WineLab.

## 4. Артефакты и источник истины

| Артефакт | Роль | Редактируется человеком |
|---|---|---|
| `cases/<caseId>.yaml` | Одобренный смысл: goal, steps, oracle, safety | Да |
| `recording.ndjson` | Неизменяемая host-owned запись действий и checks одного run | Нет |
| `results.json` | Verdict и статус исходного model-run | Нет |
| `specs/<caseId>.spec.ts` | Исполняемый regression test после codegen | Да |
| replay trace/screenshot/report | Диагностика конкретного Playwright-run | Нет |

Политика после codegen:

- YAML не управляет кликами replay;
- ручной edit `.spec.ts` — нормальный workflow;
- повторный codegen без `--force` не трогает существующий файл;
- `--force` — осознанная регенерация, diff проверяется через Git;
- recording не обновляется вслед за ручным edit spec и остаётся provenance исходной генерации.

Generated spec содержит комментарий с `caseId`, исходным run и provenance-хешами. Это не runtime-зависимость, а связь для ревью:

- YAML hash — SHA-256 точных bytes immutable YAML-копии внутри run, а не текущего файла из `packs/`;
- recording hash — SHA-256 точных UTF-8 NDJSON-строк этого `caseId` в исходном порядке, включая завершающий `\n` каждой строки.

## 5. `access.ndjson` и `recording.ndjson`

`access.ndjson` остаётся диагностическим журналом для человека и dashboard.

`recording.ndjson` — отдельный строгий контракт для codegen. Новый файл оправдан только enriched-данными; он не является rename или копией access-log.

Host пишет recording во время `qa run`. Модель не формирует NDJSON и не выбирает locator-код.

Один `recording.ndjson` принадлежит всему pack-run и может содержать строки разных `caseId`. Записываются все попытки действий и checks со статусом.

Codegen фильтрует записи по `caseId`, компилирует только успешные действия и passed checks. Неудачная попытка с последующей успешной попыткой остаётся диагностическим шумом и сама по себе не блокирует генерацию. Codegen отказывает, если неподдержанным или неоднозначным является именно успешный путь.

## 6. Locator contract

### 6.1 Готовый locator, не DOM-слепок

В момент разрешения `ref` host строит семантические locator candidates и выбирает первый, который через тот же Playwright API, который попадёт в spec:

1. имеет `count() === 1`;
2. указывает на тот же DOM element, что и ephemeral `ref`.

Уникальность по snapshot или совпадению имени недостаточна: правила Playwright matching должны совпадать на записи и replay.

```ts
type RecordedLocator =
  | { kind: "testId"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string };
```

Приоритет:

1. `data-testid`, только если он реально присутствует и locator уникален;
2. `getByLabel(value)` для form control с associated label;
3. `getByRole(role, { name })` для кнопок, ссылок и остальных именованных элементов;
4. `getByPlaceholder(value)`;
5. `getByText(value)`;
6. отказ.

`data-testid` поддерживается как optional контракт owned-продуктов, но первый fixture acceptance от него не зависит. Kernel никогда не придумывает test ID.

### 6.2 Связь с snapshot

Snapshot target внутри browser runtime хранит:

```ts
{
  ref,
  sourceSnapshotId,
  resolvedElement,
  locator: RecordedLocator | null
}
```

В recording попадают `sourceSnapshotId` и готовый locator. Codegen не открывает snapshot, чтобы повторно искать `ref=s3-e12`.

Если semantic locator не уникален, действие может быть выполнено агентом через ephemeral ref, но codegen такого кейса не пишет: `CODEGEN_UNSUPPORTED_LOCATOR`.

Первый срез поддерживает только элементы main frame. Успешное действие внутри iframe или cross-origin frame записывается, но не компилируется: `CODEGEN_UNSUPPORTED_LOCATOR`.

Scope для повторяющихся строк/таблиц не входит в первый срез. До появления scoped locator contract такие действия честно отклоняются.

## 7. Recording contract

### 7.1 Действия

```ts
interface RecordedAction {
  schemaVersion: 1;
  kind: "action";
  caseId: string;
  stepId: string;
  actionOrdinal: number;
  action: "open" | "click" | "fill" | "press" | "scroll";
  frame: "main" | "iframe" | null;
  sourceSnapshotId: string | null;
  locator: RecordedLocator | null;
  url: string | null;
  from: string | null;
  value: string | null;
  key: string | null;
  deltaY: number | null;
  actionStatus: "ok" | "failed";
  observationStatus: "complete" | "incomplete" | "failed" | null;
}
```

Правила:

- `open` нормализует полный URL к pathname + query относительно target origin; hostname стенда в spec не вшивается;
- путь `/` генерирует `page.goto(process.env.TARGET_URL!)`; другой путь — `page.goto(new URL(path, process.env.TARGET_URL!).toString())`;
- переход на другой origin не компилируется в первом срезе;
- `click` требует locator;
- `fill(from)` хранит только имя allowlisted env (`QA_EMAIL`, `QA_PASSWORD`), значение не записывается;
- `fill(value)` хранит только несекретный redacted-safe literal;
- одновременно заполненные `from` и `value`, пустые оба поля или `from` вне allowlist immutable YAML-копии делают recording невалидным;
- literal, совпадающий с известным resolved secret или прошедший secret-like detector, отклоняется host ещё до записи и повторно проверяется codegen;
- `press` хранит locator и `key`;
- page/container scroll записываются для диагностики, но успешный `scroll` не компилируется в первом срезе: `CODEGEN_UNSUPPORTED_ACTION`;
- screenshot/snapshot не становятся replay actions;
- ни одно поле recording не содержит resolved secret.

### 7.2 Typed checks

Обычная последовательность кликов не является тестом. Для генерации `expect()` recording содержит host-executed typed checks.

```ts
type RecordedCheck =
  | {
      schemaVersion: 1;
      kind: "check";
      caseId: string;
      stepId: string;
      checkOrdinal: number;
      oracle: { list: "expect" | "reject"; index: number };
      check: "url";
      path: string;
      state: "equals" | "notEquals";
      groundingText: string;
      status: "passed" | "failed" | "unbound";
    }
  | {
      schemaVersion: 1;
      kind: "check";
      caseId: string;
      stepId: string;
      checkOrdinal: number;
      oracle: { list: "expect" | "reject"; index: number };
      check: "text";
      text: string;
      exact: true;
      state: "visible" | "hidden";
      groundingText: string;
      status: "passed" | "failed" | "unbound";
    }
  | {
      schemaVersion: 1;
      kind: "check";
      caseId: string;
      stepId: string;
      checkOrdinal: number;
      oracle: { list: "expect" | "reject"; index: number };
      check: "locator";
      locator: RecordedLocator;
      state: "visible" | "hidden";
      groundingText: string;
      status: "passed" | "failed" | "unbound";
    };
```

`qa run` даёт модели browser check operations. Host сам выполняет их реальным Playwright и только затем записывает результат. Модель не может объявить check успешным текстом ответа.

До зачёта check host проверяет его связь с указанной oracle-строкой. Host извлекает конкретный semantic literal, а не засчитывает общие слова вроде `visible`, `hidden`, `opened` или `success`:

- URL check обязан содержать pathname буквально в исходной oracle-строке, например `/cabinet`;
- text check обязан содержать проверяемый exact text как case-insensitive phrase после Unicode/whitespace normalization;
- locator check обязан содержать его accessible name/label/text как такую же phrase;
- для `testId` host отдельно получает accessible name/text найденного элемента; один технический test ID без смыслового имени не связывает oracle.

`groundingText` вычисляет host из реально исполненного payload/элемента, а не принимает от модели. Если смысловая строка не найдена, host пишет `status: "unbound"`; такой check не покрывает oracle. Поэтому модель не может закрыть «открылся кабинет» проверкой текущего `/`.

Минимальные операции первого среза:

- exact pathname с `equals` / `notEquals`;
- видимый/скрытый literal text;
- видимость/скрытость однозначного semantic locator.

Codegen требует:

- каждый `oracle.expect[index]` связан минимум с одним `status: passed` положительным check;
- каждый `oracle.reject[index]` связан минимум с одним `status: passed` check с `notEquals` или `hidden`;
- check принадлежит тому же case и step;
- check использует только поддерживаемый тип assertion.

Свободная фраза «открылся кабинет» без URL/text/locator check не компилируется: `CODEGEN_UNSUPPORTED_ORACLE`.

Текущий `applyOracleCoverage` остаётся legacy review-gate для model prose/evidence и не заменяется typed checks. Появляется отдельная проверка codegen readiness:

- старый `qa run` по-прежнему может завершиться `PASS` без нового recording;
- codegenable `PASS` требует полного покрытия grounded typed checks;
- fixture acceptance требует одновременно итоговый `PASS` после `applyOracleCoverage` и полную typed-check coverage.

`qa run` сохраняет для каждого case отдельный `codegenReadiness: ready | incomplete` и список непокрытых oracle indexes. Это host-owned результат, а не мнение модели. Verdict старого MVP не меняет смысл, но `PASS` сам по себе ещё не обещает, что run можно превратить в spec.

## 8. Вход и валидация codegen

```bash
qa codegen \
  --run .qa/runs/<id> \
  --out packs/<pack>/specs
```

Вход одного pack-run:

- immutable copy approved YAML из run;
- `results.json`;
- `recording.ndjson`;
- run metadata только для provenance.

`recording.ndjson` может содержать несколько известных `caseId`. Codegen проходит cases в стабильном порядке, для каждого берёт immutable YAML-копию, один result и subset recording по `caseId`, затем независимо проверяет:

1. case присутствует в YAML-копии и `results.json` ровно один раз;
2. `executionStatus: completed` и `verdict: PASS`;
3. recording существует и schema-valid; старый run только с `access.ndjson` получает `CODEGEN_RECORDING_MISSING` и должен быть перезапущен;
4. все строки subset принадлежат этому case, ordinals уникальны и упорядочены;
5. failed action attempts игнорируются, но каждое компилируемое успешное действие поддерживается;
6. каждый target успешного действия имеет supported unique locator из main frame;
7. `fill` имеет ровно один допустимый источник: `from` или `value`;
8. recording не содержит resolved или secret-like values;
9. каждый oracle expect/reject покрыт passed grounded typed check;
10. case сохраняет `safety.mutation: none`;
11. нет unsupported external-origin/scroll/locator/check в успешном пути;
12. output-файл отсутствует либо передан `--force`.

Политика pack-run:

- non-PASS cases не генерируются и попадают в summary как `skipped: CODEGEN_RUN_NOT_PASS`;
- ошибка одного PASS-case не откатывает и не удаляет specs, уже атомарно записанные для других cases;
- mixed recording с несколькими валидными `caseId` — нормальный вход, неизвестный `caseId` — `CODEGEN_RECORDING_INVALID`;
- command возвращает non-zero, если хотя бы один PASS-case не удалось сгенерировать; обычные non-PASS skips сами по себе command не роняют.

Любая ошибка конкретного case означает отсутствие нового/перезаписанного spec только для него. Codegen работает fail-closed и сообщает per-case `CODEGEN_*` code.

## 9. Что пишет codegen

Один чистый файл на case:

```text
<out>/<caseId>.spec.ts
```

Пример первого fixture:

```ts
// Generated from case FIXTURE-001 and run fixture-recording-001.
// yaml-sha256: <hash>; recording-sha256: <hash>
import { expect, test } from "@playwright/test";

test("FIXTURE-001 — successful fixture login", async ({ page }) => {
  await page.goto(process.env.TARGET_URL!);

  await page.getByLabel("Email").fill(process.env.QA_EMAIL!);
  await page.getByLabel("Password").fill(process.env.QA_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Fixture cabinet", { exact: true })).toBeVisible();
  await expect(page.getByText("Signed in as test user", { exact: true })).toBeVisible();
  await expect(page.getByText("Authentication failed", { exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
});
```

Fixture остаётся на pathname `/`, поэтому первый generated spec намеренно не содержит выдуманный URL assertion. Для будущего typed URL check codegen сравнивает именно pathname с автоожиданием, например `expect.poll(() => new URL(page.url()).pathname)`, а не полный origin URL.

Инварианты generated code:

- импортирует только `@playwright/test` и при необходимости стандартные Node modules;
- не импортирует `qa-kernel`;
- не читает YAML/recording во время теста;
- не вызывает модель;
- не содержит secret values;
- не содержит CSS/XPath;
- использует `process.env` для target URL и allowlisted credentials;
- остаётся читаемым и пригодным для ручного edit;
- запускается напрямую через `playwright test`.

## 10. Playwright Test setup

Для первого среза добавить:

- `@playwright/test@1.62.1`, закреплённый ровно на версии текущего `playwright@1.62.1`;
- минимальный `playwright.config.ts` для fixture specs;
- Chromium;
- `workers: 1`;
- новый context на каждый test — стандартная Playwright fixture `page`;
- screenshot только при падении;
- `retries: 0` в первом срезе;
- trace с `retain-on-failure`;
- bounded test/expect timeouts;
- output directory внутри `.qa/replays/<run-id>/`.

Generated spec не зависит от этого конкретного config. В продуктовом репозитории он может использовать локальный `playwright.config.ts`.

## 11. Replay

```bash
qa replay --pack <pack> [--repeat N]
```

`qa replay` — тонкая обёртка над Playwright Test:

- находит `packs/<pack>/specs/*.spec.ts`;
- не читает YAML как runtime instructions;
- не требует `QA_MODEL_API_KEY`;
- передаёт `--repeat N` как Playwright `--repeat-each=N`;
- в первом срезе всегда использует один worker;
- сохраняет Playwright report, trace и screenshot в replay output;
- возвращает exit code Playwright без модельных `INCONCLUSIVE`.

`--repeat` по умолчанию равен `1`. Значение `10` используется только как opt-in fixture acceptance/flake probe. Для живых login-стендов repeat не включается автоматически из-за lockout, captcha, rate limit и WAF.

Тот же spec обязан запускаться без wrapper:

```bash
npx playwright test packs/<pack>/specs/FIXTURE-001.spec.ts
```

## 12. Владение specs

На первом срезе fixture spec живёт в `qa-kernel/packs/fixture-smoke/specs`.

Для реального продукта `--out` может указывать в его репозиторий:

```bash
qa codegen \
  --run .qa/runs/<id> \
  --out /path/to/product/tests/e2e/generated
```

Рекомендация: продуктовый `.spec.ts` коммитится рядом с кодом продукта, чтобы UI change и E2E change проходили в одном PR. Kernel остаётся recorder/codegen-инструментом, продуктовый репозиторий владеет regression suite.

Публикация/установка `qa-kernel` как внешнего CLI не входит в первый срез. Переносимость доказывается чистотой generated spec.

## 13. Первый вертикальный срез

Не реализуем сначала «весь recording», затем «весь codegen». Проводим один login case через весь контур.

### Срез 1. Fixture login → generated spec → replay

1. Сохраняем реальное поведение fixture: форма `Email`/`Password`, кнопка `Sign in`, успешный кабинет на том же pathname `/` с текстами `Fixture cabinet` и `Signed in as test user`.
2. В рамках среза переписываем oracle `FIXTURE-001.yaml` на literal, компилируемые условия:
   - expect: exact text `Fixture cabinet` visible;
   - expect: exact text `Signed in as test user` visible;
   - reject: exact text `Authentication failed` visible;
   - reject: heading `Sign in` visible.
3. Некомпилируемый expect `The authentication request succeeds` удаляем. Network checks не входят в первый срез.
4. `qa run` получает PASS и пишет действия `open/fill/click` плюс три grounded text checks и один grounded locator check. Host-gate сохраняет `codegenReadiness: ready`.
5. Тот же pack-run может содержать `FIXTURE-002`; его non-PASS result сообщается как skip и не мешает генерации `FIXTURE-001`.
6. `qa codegen` создаёт читаемый `FIXTURE-001.spec.ts` с `getByLabel`, `getByRole` и exact `getByText` assertions без URL assertion.
7. Spec запускается напрямую через Playwright без model API key.
8. `qa replay --repeat 10` даёт 10/10 на локальном fixture.
9. Ни один generated/runtime artifact не содержит sentinel secret.

### Срез 2. Честное падение

1. В отдельном fixture-режиме убираем или переименовываем ожидаемый cabinet marker.
2. Тот же spec падает без регенерации.
3. Replay возвращает non-zero exit code.
4. В output есть trace, screenshot и Playwright error.
5. Spec не меняется автоматически.

### Срез 3. Переносимость

1. Generated spec копируется во временный минимальный Playwright project без исходников `qa-kernel`.
2. Передаются только `TARGET_URL`, `QA_EMAIL`, `QA_PASSWORD`.
3. `npx playwright test` проходит.
4. Проверка доказывает отсутствие runtime lock-in.

Только после трёх срезов можно пробовать запись реального read-only продукта.

## 14. Тестовая стратегия

### Unit

- locator selection выбирает только реально существующий unique candidate;
- optional test ID не придумывается;
- secret `fill(from)` не сохраняет value;
- literal `fill(value)` записывается после redaction check;
- action/check ordinals стабильны;
- oracle coverage требует typed checks для каждого expect/reject;
- check, не grounded в своей oracle-строке, получает `unbound` и codegen возвращает `CODEGEN_UNSUPPORTED_ORACLE`;
- failed click с последующим успешным click не блокирует codegen и в spec попадает только успешное действие;
- mixed valid `caseId` в одном recording корректно разделяются на независимые subsets/specs;
- locator uniqueness проверяется тем же Playwright locator API и тем же DOM element, которые будут использованы в spec;
- unsupported locator/check/action возвращает конкретный `CODEGEN_*`;
- старый run без `recording.ndjson` возвращает `CODEGEN_RECORDING_MISSING`;
- существующий spec не перезаписывается без `--force`;
- generated source не содержит imports из `qa-kernel` и resolved secrets.

### Integration fixture

- PASS `qa run` создаёт полный recording;
- FAIL/BLOCKED/INCONCLUSIVE/CASE_ERROR не генерируют spec;
- один pack-run с `FIXTURE-001` и `FIXTURE-002` генерирует PASS-case и отдельно сообщает skip для non-PASS case;
- login codegen создаёт компилируемый TypeScript;
- прямой Playwright-run проходит;
- намеренная поломка даёт красный replay и artifacts;
- переносимый spec работает в минимальном внешнем Playwright project.

### Quality gates

- `bun run typecheck`;
- `bun test test/*.test.ts`;
- `package.json` содержит ровно закреплённый `@playwright/test@1.62.1`, а `npx playwright --version` подтверждает совместимую версию;
- generated fixture spec проходит TypeScript/Playwright loading;
- `qa replay --repeat 10` даёт 10/10 только на локальном fixture;
- sentinel secret отсутствует в spec, recording и replay artifacts.

## 15. Ошибки codegen

Минимальный стабильный набор:

| Code | Причина |
|---|---|
| `CODEGEN_RUN_NOT_PASS` | Case не завершился подтверждённым PASS |
| `CODEGEN_RECORDING_MISSING` | Нет полного recording для case |
| `CODEGEN_RECORDING_INVALID` | Схема/ordinals/ownership recording неверны |
| `CODEGEN_UNSUPPORTED_LOCATOR` | Нет однозначного semantic locator |
| `CODEGEN_UNSUPPORTED_ORACLE` | Oracle не покрыт typed check |
| `CODEGEN_UNSUPPORTED_ACTION` | Действие нельзя честно скомпилировать |
| `CODEGEN_MUTATION_NOT_NONE` | Case не read-only в первом срезе |
| `CODEGEN_SECRET_LEAK` | В recording/output найден resolved secret |
| `CODEGEN_OUTPUT_EXISTS` | Spec уже существует без `--force` |

Ошибка codegen не меняет approved YAML, recording или существующий spec.

## 16. За границами этапа

- `safety.mutation: controlled`;
- create/update/delete и cleanup;
- generated unique test data;
- scoped locators для повторяющихся таблиц/строк;
- любой replay scroll;
- iframe/cross-origin frame actions;
- shared `storageState`;
- параллельный replay;
- Firefox/WebKit;
- visual regression;
- Atlas/WineLab acceptance;
- `qa diagnose`;
- `qa heal`;
- автоматическое изменение spec после падения;
- публикация kernel как npm package/service.

Следующий отдельный план после зелёного replay:

```text
controlled mutations
→ generated data bindings
→ explicit cleanup recording
→ try/finally
→ 10/10 без оставшихся сущностей
```

После него — diagnose с бакетами `product / test / environment / capability` и patch только как reviewable diff.

## 17. Что не делать

- Не использовать Playwright Planner/MCP/LLM в codegen или replay.
- Не генерировать spec из Discover drafts.
- Не парсить model prose в locator/assertion.
- Не восстанавливать target по старому snapshot/ref.
- Не писать spec без assertions.
- Не добавлять CSS/XPath fallback ради зелёного demo.
- Не обещать CRUD до controlled-mutation контракта.
- Не запускать `--repeat 10` по умолчанию на живом login-стенде.
- Не начинать с Atlas/WineLab.
- Не писать diagnose/heal до красного/зелёного fixture replay.

## 18. Definition of Done

Этап завершён, когда одновременно выполнено всё:

- [ ] `FIXTURE-001.yaml` переписан на четыре literal text/locator-компилируемых oracle без network claim;
- [ ] `qa run` approved fixture pack пишет schema-valid enriched `recording.ndjson` с несколькими `caseId` при необходимости;
- [ ] recording содержит все attempts, а codegen выбирает только успешный путь;
- [ ] каждое oracle expect/reject связано с host-executed passed и host-grounded check;
- [ ] unbound check не может сделать case codegenable;
- [ ] `applyOracleCoverage` остаётся legacy verdict-gate, typed checks отдельно определяют codegen readiness;
- [ ] `qa run` сохраняет host-owned `codegenReadiness` и непокрытые oracle indexes;
- [ ] `qa codegen` из PASS-run создаёт читаемый `FIXTURE-001.spec.ts`, не блокируясь на non-PASS `FIXTURE-002`;
- [ ] generated spec использует только semantic Playwright locators;
- [ ] generated spec импортирует только `@playwright/test`/Node standard modules;
- [ ] generated spec не читает kernel YAML/recording и не вызывает модель;
- [ ] existing spec не перезаписывается без `--force`;
- [ ] provenance hashes считаются по immutable YAML-копии run и case subset исходного recording;
- [ ] `@playwright/test@1.62.1` установлен и согласован с `playwright@1.62.1`;
- [ ] `qa replay` работает без `QA_MODEL_API_KEY`;
- [ ] direct `npx playwright test` работает без wrapper;
- [ ] fixture login даёт 10/10 replay;
- [ ] намеренная поломка делает replay красным и оставляет trace/screenshot/error;
- [ ] переносимый spec проходит в минимальном внешнем Playwright project;
- [ ] sentinel secret отсутствует во всех новых artifacts;
- [ ] `bun run typecheck` зелёный;
- [ ] `bun test test/*.test.ts` зелёный;
- [ ] mutations, Atlas, diagnose и heal не были добавлены скрытно.
