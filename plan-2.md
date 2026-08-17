# qa-kernel — план unattended lab и multi-site проверки

## 1. Зачем нужен этот план

Первый MVP уже существует: `qa-kernel` умеет выполнять approved cases моделью в Chromium, сохранять evidence, валидировать verdict, продолжать pack после локального `CASE_ERROR` и строить per-run report/dashboard.

Следующая гипотеза шире:

> За ночь система самостоятельно прогоняет десятки разрешённых non-production сайтов и утром честно показывает, где kernel работает, где ошибся и на каком evidence это видно.

Цель — не получить много `PASS` и не посчитать открытые страницы. Цель — измерить:

- дошёл ли каждый запланированный target до конца;
- совпал ли verdict с заранее утверждённым oracle;
- существует ли evidence именно нужного case/step;
- не приняла ли модель loading, tool error или недоступный control за дефект продукта;
- не осталось ли секретов, потерянных результатов или zombie Chromium;
- можно ли понять причину любого расхождения по одному сохранённому run.

Этот документ начинается с текущего состояния репозитория. Старый `PLAN.md` остаётся историей построения MVP.

## 2. Текущий baseline

### Подтверждено tests и сохранёнными artifacts

- `discover`, `validate`, `run`, `report`, `lab` работают как отдельные workflows.
- Pi изолирован и получает только custom tool `browser`; финальный текст берётся из session-owned assistant message с delta fallback.
- Один case использует новую Pi session и новый BrowserContext.
- Evidence host-owned: ID, case, step, action, file и hash проверяются host.
- Секреты вводятся через `fill(from)` и проходят redaction/sentinel gates.
- Ранний Observation и полное 1500 ms network attribution window разделены: после раннего settle host ждёт конец attribution window перед `recordNetwork`; regression с XHR, стартующим через 700 ms, зелёный.
- Invalid result получает один repair без browser tools, затем локальный `CASE_ERROR`; следующий case продолжает pack.
- Весь case lifecycle, включая `createCase`, repair, persist и context close, находится внутри локальной границы case.
- После browser death host делает один bounded restart без retry product case; оставшиеся cases не исчезают.
- Launch, browser phase, abort grace, finalization, repair, context close и browser close имеют отдельные host-owned budgets.
- Child exit `2`, `130` или signal death не может быть скрыт последним `COMPLETED` checkpoint.
- CAB-003 требует evidence шага `observe-disabled`; finalization/repair видят только существующий evidence manifest.
- Scroll state страницы или контейнера входит в Observation и no-progress fingerprint; CAB-006 проверяет click после scroll.
- SIGINT process-tree тест завершает run с `130` без zombie Chromium.
- Каждый run пишет `access.ndjson` и `dashboard.html`; URL содержит только origin + pathname.
- Per-run dashboard открывается через `file://`; Copy использует Clipboard API, затем `execCommand`, иначе показывает явную ошибку.
- Каждый lab repeat выполняется в отдельном OS process; root dashboard остаётся компактным index на per-run dashboards.
- `bun test` и `bun run typecheck` являются обязательными regression gates перед следующим live acceptance.

### Живой результат этапа A

Три последовательных controlled acceptance-прогона дали одну матрицу `30/30`:

- `.qa/labs/lab-acceptance-20260816-230730`;
- `.qa/labs/lab-acceptance-20260817-000118`;
- `.qa/labs/lab-acceptance-20260817-015726`.

Канонический artifact — последний run: три полных repeats, `27 PASS`, три ожидаемых `CAB-004 = FAIL`, `CASE_ERROR = 0`, `MISSING = 0`, `stable: yes`. Все 535 evidence files существуют и совпадают по hash; проверка известных fixture secrets зелёная.

### Историческая диагностика до закрытия A

Первый `lab-smoke` дал только 32 результата из 50:

```text
repeat:       5
persisted:    32 результата вместо 50
PASS:         23
FAIL:          5
BLOCKED:       1
CASE_ERROR:    3
stable:       no
```

Он обнаружил классы ошибок, которые затем закрыли A1–A6:

1. `run-02`: `CAB-001` завершился локальным `BLOCKED environment`; создание BrowserContext следующего case упало с `Target page, context or browser has been closed`; pack стал `ERROR`.
2. `run-04`: процесс завис до первого access event; текущий пятиминутный abort не гарантировал выход из `await session.prompt`.
3. `run-05`: модель выдумала evidence ID `env-blocked-001`; host правильно создал локальный `CASE_ERROR`; следующий event точно содержит `async newContext: Target page, context or browser has been closed`, после чего pack стал `ERROR`.
4. `CAB-003`: модель дважды сослалась на evidence шага `open-login` как на evidence шага `observe-disabled`; host правильно отверг result.
5. `CAB-006`: scroll нестабилен — `FAIL / PASS / FAIL`. При прокрутке через пустой участок no-progress fingerprint не видит изменения scroll position.

Ранние каталоги `lab-acceptance-*`, созданные до зелёных lifecycle/watchdog tests, считаются диагностическими прогонами, а не доказательством Gate A. Канонический Gate A опирается на свежий полный artifact `015726` и ручную проверку evidence.

## 3. Главный порядок работ

Переход между этапами разрешён только после выполнения gate предыдущего этапа:

```text
A. Честная unattended lab 3/3
→ B. Batch: lab + Atlas
→ C. Три утверждённых стенда
→ D. 10 сайтов × 3 ночи
→ E. 20–30 сайтов
```

Этап A по controlled lab закрыт. Перед реализацией batch текущий working tree нужно оформить в git и подготовить 2–3 approved Atlas cases. До этого не добавляем WineLab pack, registry или новые SPA.

## 4. Неподвижные решения

- Только явно разрешённые non-production targets.
- Только `safety.mutation: none`.
- Oracle существует до ночного run и проходит ручной approve.
- `discover` может подготовить draft, но не участвует в ночной оценке.
- Модель выносит смысловой verdict; host проверяет механику evidence и полноту исполнения.
- `CASE_ERROR` одного case не останавливает pack.
- `ERROR`, `ABORTED`, `MISSING` и `CASE_ERROR` не могут дать зелёный lab/batch.
- Product `FAIL` не retry-ится автоматически.
- Infra-retry не должен скрывать исходную нестабильность.
- Один target выполняется в отдельном OS process.
- Сначала concurrency `1`.
- Секреты остаются env refs; manifest никогда не содержит их значения.
- Общий dashboard — index со ссылками; подробный access trail живёт в per-run dashboard.
- Статический dashboard не пишет `notes.ndjson`. Ближайший feedback flow — надёжный Copy note.
- Qwen/local provider, БД, scheduler service, параллельные Chromium и UI-продукт не входят в этот план.

## 5. Что означает «честный unattended run»

Run считается попытанным только если для него существует финальный persisted status.

Lab считается стабильной только если одновременно:

- создано ровно ожидаемое число repeats;
- каждый repeat содержит полный список case IDs из approved pack;
- каждый case имеет persisted result;
- каждый actual verdict совпадает с expected verdict;
- нет `MISSING`, `ERROR`, `ABORTED` и `CASE_ERROR`;
- runner завершился самостоятельно;
- все evidence files существуют и совпадают по hash;
- sentinel secret отсутствует во всех output surfaces;
- после завершения нет Chromium, принадлежащего run.

Наличие большого числа `PASS` не компенсирует неполный run.

## 6. Этап A — честная unattended lab

### A1. Fail-closed scorecard

Сейчас `scoreLab` выводит case IDs из фактически сохранённых results. Пустой или полностью пропущенный case поэтому может исчезнуть из таблицы и не сделать lab красной.

Новый scoring input должен содержать:

```ts
type LabRun = {
  id: string;
  status: "COMPLETED" | "ERROR" | "ABORTED" | "MISSING";
  results: CaseResult[];
};

type LabScoreInput = {
  expectedRepeatCount: number;
  expectedCases: Record<string, Verdict>;
  runs: LabRun[];
};
```

Правила:

1. Список expected cases берётся из загруженного approved pack, а не из results.
2. `lab.yaml` задаёт исключения из default expected `PASS`, например `CAB-004: FAIL`.
3. Число runs должно точно совпадать с `repeat`.
4. Отсутствующая папка, results или case становится `MISSING`.
5. Дублированный case ID делает run ошибочным.
6. `executionStatus: error` отображается как `CASE_ERROR`.
7. Любой child `ERROR` или `ABORTED` делает aggregate неуспешным.
8. Aggregate получает `COMPLETED` только когда все scheduled runs полностью попытаны.
9. SIGINT lab возвращает `130`, а не пустой зелёный scorecard.

Обязательные тесты:

- `scoreLab([], expectedCases)` красный;
- один пустой repeat красный;
- expected case отсутствует во всех repeats — красный;
- repeat отсутствует — красный;
- child `ERROR` с валидными results всё равно красный;
- child `ABORTED` возвращает aggregate `ABORTED` и exit `130`;
- три полных совпавших repeats зелёные;
- expected `FAIL` считается совпадением, а не ошибкой lab.

### A2. Локальная граница всего case lifecycle

Сейчас `controller.createCase()` вызывается до локального case `try/catch`. Ошибка создания context попадает в общий `run ERROR` и обрывает pack.

Под локальную границу case должны попасть:

```text
resolve secrets
→ создать EvidenceStore
→ создать BrowserContext
→ создать Pi session
→ выполнить browser phase
→ finalization/repair
→ validate result/evidence
→ persist result
→ закрыть context
```

Правила:

- любая ошибка этой цепочки создаёт persisted `CASE_ERROR` текущего case;
- уже завершённый `PASS/FAIL/BLOCKED/INCONCLUSIVE` не меняется из-за следующего case;
- ошибка `browser.close()` записывается как техническая диагностика, но не стирает уже persisted result;
- после каждого case обновляются `results.json`, `meta.json`, `events.ndjson` и dashboard;
- следующий case должен быть попытан, если пользователь не abort'ил весь run.

Обязательные integration tests:

- `createCase` падает для второго case → второй получает `CASE_ERROR`, третий запускается;
- repair возвращает неизвестный evidence ID → текущий `CASE_ERROR`, следующий запускается;
- первый case возвращает `BLOCKED` → pack продолжает остальные cases;
- context close падает после persisted result → result остаётся доступен.

### A3. Восстановление Chromium после browser death

Если Chromium process или Playwright Browser умер, создавать новые contexts в старом controller бессмысленно.

Минимальная recovery policy:

1. Ошибка `createCase` остаётся `CASE_ERROR` текущего case.
2. Host закрывает старый controller best-effort.
3. Перед следующим case host один раз запускает новый Chromium.
4. Повторного выполнения упавшего product case нет.
5. Если restart не удался, оставшиеся cases получают явный технический статус, а run заканчивается `ERROR`; они не исчезают из results.
6. Никаких бесконечных restart loops.
7. Host владеет process tree каждого запущенного Chromium: restart разрешён только после bounded close старого browser и подтверждения, что owned process tree завершён; по timeout host принудительно завершает только этот tree и дожидается reap.

Обязательный process test:

- тестовый Chromium закрывается между cases;
- следующий case запускается в новом Browser process;
- pack сохраняет полный список results;
- после run не остаётся дочернего Chromium.

### A4. Host-owned deadlines

Текущий пятиминутный timer начинается внутри `promptWithFinalization` после создания runtime/session и вызывает только `session.abort()`. Это не является wall-clock timeout всего case.

Нужны отдельные bounded deadlines. Это последовательные окна, а не один общий шестиминутный timer:

| Область | Бюджет | Результат превышения |
|---|---:|---|
| Chromium launch | 30 s | run infrastructure error или restart failure |
| Browser-enabled case phase | 5 min | снять browser tools, abort browser/model work |
| Abort grace для зависшего browser/model await | 5 s | завершить текущий await через host escape hatch |
| Tool-free finalization | 30 s | локальный `CASE_ERROR` |
| Structured result repair | 30 s | локальный `CASE_ERROR` |
| Context close | 10 s | best-effort cleanup diagnostic |
| Browser close | 10 s | принудительное завершение owned process tree |

Правила реализации:

- deadline создаёт host до `createCase`;
- пользовательский SIGINT и case deadline объединяются в один signal для browser-enabled работы;
- этот signal получают Playwright actions, settle, attribution wait и active Pi prompt;
- истечение browser phase реально abort'ит общий browser/model signal, а не только вызывает `session.abort()`;
- timeout не считается product `FAIL`;
- tool-free finalization начинает собственное полное 30-секундное окно после остановки browser phase и не получает browser tools;
- repair начинает отдельное полное окно после finalization/result validation; медленный честный browser case не съедает budget JSON repair;
- host escape hatch завершает только тот await, который не умер за abort grace, даже если SDK abort promise не резолвится;
- если session ещё не создана, finalization не запускается и case получает техническую ошибку setup/launch;
- cleanup всегда выполняется в `finally` и также bounded;
- события содержат конкретный timeout code, а не только свободный текст.

Обязательные tests:

- session prompt никогда не резолвится → case завершается в тестовом коротком budget;
- browser action зависает в settle → signal разрывает action;
- finalization зависает → локальный `CASE_ERROR`;
- browser phase заканчивается у лимита → finalization и repair всё равно получают собственные полные test budgets;
- Chromium launch не завершается → bounded failure;
- после timeout следующий case запускается;
- SIGINT и deadline не оставляют zombie process.

### A5. CAB-003: evidence нужного semantic step

Host validation не ослабляется. Evidence от `open-login` нельзя автоматически переклеивать на `observe-disabled`.

Исправления:

- инструкция `CAB-003` явно требует `browser.snapshot` со `stepId: observe-disabled` перед verdict;
- execution prompt напоминает: каждый claim ссылается только на evidence того же step;
- finalization и repair получают host-owned manifest существующих evidence IDs, сгруппированный по step;
- repair не получает browser tools и не может invent'ить новые IDs;
- если evidence нужного step не существует, result остаётся локальным `CASE_ERROR` или честным `INCONCLUSIVE`, если такой result был сформирован до repair.

Tests:

- claim с ID другого step отклоняется;
- snapshot нужного step принимается;
- repair видит только существующие IDs;
- unknown `env-blocked-001` не проходит validation;
- invalid evidence одного case не обрывает pack.

### A6. CAB-006: scroll должен считаться прогрессом

Текущий no-progress fingerprint сравнивает URL, text, interactive и network. При прокрутке через пустую область эти данные могут не измениться, хотя viewport реально движется.

Observation/ActionResult должны включать безопасное scroll state:

```ts
type ScrollState = {
  scope: "page" | "container";
  x: number;
  y: number;
  maxX: number;
  maxY: number;
};
```

Правила:

- page scroll возвращает текущие offsets и пределы страницы;
- container scroll возвращает offsets выбранного scroll owner;
- no-progress fingerprint включает нормализованный scroll state;
- изменение scroll position сбрасывает identical-observation counter;
- одинаковая позиция у границы страницы не считается прогрессом;
- refs после scroll остаются свежими;
- модель не получает raw DOM/CSS selectors.
- fixture делает успешный click наблюдаемым, например показывает `Below control clicked`; Gate A не основывается только на наличии текста кнопки в полном body/ARIA.

Tests:

- три scroll через пустой промежуток с разными offsets не дают `no_progress`;
- три scroll на неизменяемой границе дают `no_progress`;
- page control после большого gap находится и кликается;
- container control после внутреннего scroll находится и кликается;
- snapshot caps 60/20 сохраняются.

Если после исправления fingerprint control всё ещё нестабилен, сначала чинятся scroll owner/offsets и observable fixture response. Oracle не ослабляется ради зелёного scorecard. Временный диагностический case может проверять только появление control в Observation, но он не закрывает Gate A вместо исходного click case.

### A7. Access и dashboard hygiene

Access URL сохраняется как:

```text
origin + pathname
```

Query и hash не попадают в `access.ndjson`, terminal line, report и dashboard.

Per-run dashboard:

- показывает verdicts, access trail и screenshots;
- открывается напрямую через `file://`;
- `Copy note` сначала использует Clipboard API, затем selection/`execCommand` fallback;
- показывает `Copied` или явную ошибку;
- не пытается писать файлы из статического HTML.

Lab root dashboard:

- показывает одну строку на repeat;
- показывает status, counts, duration и ссылку на `run-XX/dashboard.html`;
- не склеивает все screenshots в один HTML;
- сохраняется даже при abort/error.

Tests:

- access URL с token в query не сохраняет token;
- per-run screenshot links открываются;
- Copy работает из `file://` в локальном Chromium или выдаёт понятный fallback;
- root index содержит ссылки на все scheduled repeats, включая missing/error;
- root index не содержит inline gallery дочерних runs.

Для Gate A обязательны URL sanitizer и root index. Copy fallback полезен оператору, но не блокирует запуск acceptance `3/3`; если он не готов к A9, его нужно закрыть сразу после Gate A и до этапа B.

### A8. Acceptance этапа A

Acceptance запускается только после зелёных A1–A6, включая lifecycle boundary, browser recovery и host watchdog. Dashboard work не должен отправлять lab в live до выполнения этих зависимостей.

Команда:

```bash
set -a && source .env && set +a
bun run qa lab \
  --pack packs/lab-smoke \
  --repeat 3 \
  --out .qa/labs/lab-acceptance-<timestamp>
```

`packs/lab-smoke/lab.yaml` сохраняет `repeat: 5` как soak-default. Acceptance всегда явно фиксирует `--repeat 3`, поэтому изменение default не является частью Gate A.

Ожидаемая матрица:

| Case | r1 | r2 | r3 |
|---|---|---|---|
| CAB-001 | PASS | PASS | PASS |
| CAB-002 | PASS | PASS | PASS |
| CAB-003 | PASS | PASS | PASS |
| CAB-004 | FAIL | FAIL | FAIL |
| CAB-005 | PASS | PASS | PASS |
| CAB-006 | PASS | PASS | PASS |
| CAB-007 | PASS | PASS | PASS |
| CAT-001 | PASS | PASS | PASS |
| CAT-002 | PASS | PASS | PASS |
| CAT-003 | PASS | PASS | PASS |

Gate A закрыт только если:

- [x] есть три полных run directories;
- [x] в каждом ровно десять persisted results;
- [x] verdict matrix совпадает 30/30;
- [x] `CAB-004 = FAIL` подтверждён UI alert и `/api/reports = 500` во всех трёх repeats;
- [x] `CASE_ERROR = 0`;
- [x] `MISSING = 0`;
- [x] child `ERROR/ABORTED = 0`;
- [x] lab process завершился самостоятельно;
- [x] scorecard имеет `stable: yes`;
- [x] root index открывает каждый per-run dashboard;
- [x] 535 evidence files существуют и совпадают по hash;
- [x] sentinel/fixture-secret scan зелёный;
- [x] owned Chromium processes после run отсутствуют;
- [x] вручную просмотрены все три `CAB-004` и пять PASS: `CAB-001`, `CAB-003`, `CAB-005`, `CAB-006`, `CAT-003`.

Проверенный artifact: `.qa/labs/lab-acceptance-20260817-015726`. Gate A закрыт. Этап B начинается только после оформления текущего working tree и подготовки утверждённого Atlas pack.

## 7. Этап B — минимальный multi-target batch

Этап начинается только после Gate A.

### B1. Реальные packs до команды batch

Первый pilot содержит только существующие и утверждённые targets:

1. `lab-smoke` как control;
2. Atlas non-production pack.

До реализации batch Atlas pack должен иметь 2–3 approved cases:

- happy login/read-only landing;
- известный negative или blocked state с утверждённым oracle;
- один характерный interaction, если он безопасен.

WineLab не появляется в manifest, пока для него нет approved pack и разрешённого stand.

### B2. Команда

Controlled fixtures остаются `qa lab`. Несколько независимых targets запускает отдельная команда:

```bash
qa batch \
  --manifest packs/nightly-pilot.yaml \
  --out .qa/nightly/<night-id>
```

Минимальный manifest ниже показывает целевой формат B2 и не является готовым к запуску baseline. Atlas entry добавляется только после выполнения B1 и появления 2–3 approved cases:

```yaml
schemaVersion: 1
id: nightly-pilot
targets:
  - id: lab
    pack: packs/lab-smoke
  - id: atlas
    pack: packs/b2b-login
```

Manifest содержит только IDs и pack paths. URL, origins и credentials определяются env refs внутри каждого pack.

### B3. Batch runner contract

- preflight валидирует manifest и каждый pack;
- missing env одного target создаёт target-level error, но не блокирует остальные;
- каждый target запускается отдельным OS child process;
- concurrency равен `1`;
- target имеет hard wall-clock 30 минут;
- завершение child process, exit code и artifacts фиксируются немедленно;
- падение child не останавливает очередь;
- batch state атомарно обновляется после каждого target;
- повторный запуск с тем же output directory пропускает только полностью завершённые targets;
- incomplete/error targets не перезапускаются молча: resume явно помечает новую attempt;
- product `FAIL` не retry-ится;
- SIGINT завершает текущий process tree, сохраняет state и возвращает `130`;
- общий index содержит ссылки на target dashboards, а не копии их screenshots.

Артефакты:

```text
.qa/nightly/<night-id>/
  manifest.yaml
  state.json
  scorecard.md
  dashboard.html
  targets/
    lab/
      attempt-01/
        ... обычные run artifacts
    atlas/
      attempt-01/
        ... обычные run artifacts
```

### B4. Gate pilot

- [ ] control lab проходит тем же expected verdict matrix;
- [ ] Atlas имеет полный approved result set;
- [ ] падение одного child не мешает попытке второго target;
- [ ] target timeout действительно убивает только owned process tree;
- [ ] resume не дублирует completed target;
- [ ] aggregate никогда не зелёный при missing target;
- [ ] все расхождения вручную объяснены по evidence;
- [ ] две последовательные ночи завершаются без ручного kill.

## 8. Этап C — три утверждённых стенда

После pilot добавляется один новый реальный pack, предпочтительно ограниченный read-only участок WineLab.

Состав:

1. controlled lab;
2. Atlas;
3. WineLab или другой разрешённый B2B staging.

На каждом живом стенде остаётся 2–3 cases:

- happy path;
- known negative;
- один сложный interaction: table, modal, scroll-container или slow network.

Gate C:

- [ ] все три targets полностью попытаны две ночи подряд;
- [ ] ни один target не требует ручного kill;
- [ ] все known-negative cases дают ожидаемый verdict;
- [ ] нет ложного PASS по loading/tool error;
- [ ] нет secret leaks и invalid evidence;
- [ ] все расхождения объяснены и классифицированы;
- [ ] Atlas и третий стенд дают стабильный verdict `3/3` на happy path.

## 9. Этап D — 10 сайтов

Только после Gate C формируется реестр из десяти разрешённых сайтов.

Правила набора:

- не больше 2–3 approved cases на target;
- обязательны happy и known-negative cases;
- сайты добавляют UI-разнообразие, а не десять одинаковых логинов;
- mutation остаётся `none`;
- production не используется;
- каждый oracle утверждён до первой оцениваемой ночи.

Желаемые типы взаимодействий по всему набору:

- классическая login form;
- disabled/enabled controls;
- SPA navigation без URL reload;
- таблица с большим числом строк;
- header icon;
- page scroll и container scroll;
- modal/drawer;
- slow XHR;
- analytics/prefetch/long-poll noise;
- empty/error states.

Приёмка выполняется три последовательные ночи.

### Метрики

- `scheduledTargets`;
- `attemptedTargets`;
- `completedTargets`;
- `scheduledCases`;
- `persistedCases`;
- counts verdicts и technical statuses;
- oracle agreement;
- false PASS на known-negative cases;
- median/p95 duration;
- median/p95 browser actions;
- token usage/cost;
- evidence/hash failures;
- secret scan failures;
- zombie process failures.

### Gate D

- [ ] 100% scheduled targets получили persisted target status;
- [ ] не менее 95% scheduled cases завершились без `CASE_ERROR` или infra block;
- [ ] не менее 95% completed verdicts совпали с oracle;
- [ ] ложных PASS на known-negative cases — 0;
- [ ] secret leaks — 0;
- [ ] invalid/missing evidence — 0;
- [ ] zombie Chromium — 0;
- [ ] batch ни разу не потребовал ручного kill;
- [ ] вручную проверены все расхождения и минимум десять случайных PASS каждой ночи.

## 10. Этап E — 20–30 сайтов

Расширение начинается только после трёх ночей Gate D.

Сначала сохраняется concurrency `1`. Concurrency `2` рассматривается только если фактическая длительность не помещается в ночное окно и при этом:

- нет provider rate-limit instability;
- нет локальной CPU/memory contention;
- process isolation tests зелёные;
- результаты concurrency `1` служат baseline.

Никаких иных архитектурных изменений для масштаба сначала не требуется.

## 11. Test strategy

### Unit

- fail-closed scoring;
- exact repeat/case inventory;
- aggregate status/exit codes;
- access URL sanitizer;
- scroll-state fingerprint;
- manifest validation;
- resume state transitions.

### Integration

- createCase failure остаётся локальным;
- browser restart между cases;
- hung model prompt;
- hung browser action;
- hung finalization;
- bounded launch/close;
- repair с valid evidence manifest;
- unknown evidence ID;
- root index links;
- child crash и продолжение batch;
- SIGINT process tree.

### Controlled live

- `lab-smoke` 3/3;
- все 30 results;
- ожидаемый negative `CAB-004`;
- ручная проверка evidence;
- sentinel scan;
- отсутствие zombies.

### External live

- только approved non-production packs;
- сначала Atlas;
- потом один дополнительный B2B staging;
- все mismatches проходят ручной review;
- discover output не считается acceptance result.

## 12. Порядок реализации этапа A

Изменения делаются маленькими вертикальными кусками:

1. [x] **Fail-closed score**
   Красные tests для empty/missing/error/aborted → минимальный scoring fix.

2. [x] **Case lifecycle boundary**
   `createCase`/repair/close failures → локальный `CASE_ERROR` → следующий case запускается.

3. [x] **Browser recovery**
   Умерший Chromium → один bounded restart → следующий case.

4. [x] **Host watchdog**
   Hung prompt/action/launch/finalization/cleanup → bounded result без zombie.

5. [x] **Evidence step discipline**
   CAB-003 + evidence manifest для finalization/repair.

6. [x] **Scroll progress**
   CAB-006 + page/container offsets в fingerprint.

7. [x] **Observer hygiene**
   Обязательные URL sanitizer и root lab index; Copy fallback можно закончить сразу после Gate A, но до B.

8. [x] **Полный regression suite**
   Unit, integration, process-tree, typecheck.

9. [x] **Живой Gate A**
   Новый `lab-smoke --repeat 3`, без reuse старых failed artifacts.

Следующий кусок начинается только после зелёного теста предыдущего. Не объединять все девять пунктов в один рефакторинг.

Живой пункт 9 запрещено начинать до завершения пунктов 1–6. В частности, fail-closed score и красивый index не являются основанием запускать `3/3`, пока hung prompt, browser death и signal propagation не закрыты tests.

Исторически первые `lab-acceptance-*` запускались раньше этого рубежа и используются только как диагностические artifacts. Закрывающим Gate A считается полный проверенный run `015726`.

## 13. Что намеренно не делаем

- Не создаём десятки случайных SPA ради количества.
- Не запускаем неизвестные public sites без разрешения и oracle.
- Не подключаем production.
- Не добавляем mutations.
- Не включаем Qwen/local provider.
- Не строим web UI, БД, accounts или SSE.
- Не делаем автоматический approve.
- Не добавляем scheduler service: готовую команду позже вызовет shell/cron/CI.
- Не пишем `notes.ndjson` из статического HTML.
- Не склеиваем screenshots всех sites в один огромный dashboard.
- Не включаем параллельные Chromium до доказанной необходимости.
- Не скрываем flakes автоматическим retry.
- Не ослабляем evidence validation ради зелёной lab.

## 14. Definition of Done этого плана

План выполнен, когда:

- [x] Gate A: controlled lab стабильно зелёная `3/3`;
- [ ] Gate B: lab + Atlas завершаются две ночи подряд;
- [ ] Gate C: три утверждённых стенда не требуют ручного сопровождения;
- [ ] Gate D: десять сайтов проходят три последовательные ночи по заданным метрикам;
- [ ] batch продолжает работу после target-level crash;
- [x] неполный lab run никогда не выглядит зелёным, включая child exit поверх сохранённого checkpoint;
- [ ] false PASS на known-negative cases отсутствуют;
- [ ] evidence каждого расхождения открывается из dashboard;
- [ ] секреты не появляются в artifacts;
- [ ] процессы не остаются после timeout/SIGINT;
- [ ] после доказанной стабильности система готова расшириться до 20–30 targets без смены kernel architecture.

Главный достигнутый результат:

> Одна полностью честная ночь на `lab-smoke`, которую не нужно убивать руками.

Следующий рубеж — Gate B: утверждённый Atlas pack и минимальный sequential batch `lab + Atlas`.
