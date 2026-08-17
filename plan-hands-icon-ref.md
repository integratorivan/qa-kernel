# План: безымянная иконка не получает `ref`

Передай агенту этот файл целиком. Цель — починить руки snapshot, не растить Atlas-регресс и не ослаблять oracle.

## Зачем

На живом Atlas (`B2B-006`) модель видит в ARIA безымянные `button > img` рядом с «Шаблоны», но в `observation.interactive` у них нет `ref`. Кликать нечем. Два независимых прогона:

- `.qa/runs/atlas-hands` (агент): `B2B-006 = BLOCKED / capability`
- повтор пользователя: `B2B-006 = CASE_ERROR / RESULT_REPAIR_TIMEOUT` (клика по иконке в access нет — только snapshot/scroll)

Это дыра ядра, не баг Atlas.

## Что сломано

Файл: `src/browser.ts`, `#capture`, сбор кандидатов.

Иконка колонок — видимый `<button>` (или `role=button`) с `<img>` внутри. У неё нет `aria-label`, `title`, `placeholder`, текста (пунктуация/символ режется в `ownText`), она не внутри `th` и не внутри `label / [role=group] / [role=region]`.

Тогда:

```ts
const name = ariaLabel || labels || title || placeholder || ownText || (header ? `${header} — control` : nearby);
if (!name) return null;
```

Кандидат **выбрасывается до** сортировки и до cap 60. В `omittedCount` он не попадает. В `aria` модели он виден — отсюда путаница.

Лабораторная лупа в шапке таблицы работает только потому, что `closest("th")` даёт имя вида `Код товара — control`. Тулбар матрицы так не именуется.

## Что не чинить

- Не добавлять в interactive сырой SVG, каждую `td/tr`, любой `cursor:pointer` без контекста. Это правило PLAN.md §7.1 п.7.
- Не поднимать cap 60/20 «чтобы влезло».
- Не ослаблять `B2B-006` oracle и не перекладывать кейс в skip.
- Не писать `qa batch`, не трогать WineLab, не плодить Atlas-кейсы.
- Не менять lifecycle `ref`: после DOM/scroll/навигации ref по-прежнему дохнет.

## Что сделать

В `#capture` дать имя **видимому button/role=button без accessible name**, если рядом есть понятный локальный текст.

Порядок источников имени не ломать:

1. aria / label / title / placeholder / ownText — как сейчас  
2. `th` / `[role=columnheader]` — как лупа  
3. **новое:** ближайший видимый контекст тулбара, не вся страница:
   - предыдущий/соседний подписанный control в том же родителе (пример: «Шаблоны»)
   - `aria-labelledby`
   - короткий текст родителя-тулбара / `[role=toolbar]` / группы фильтров, не `innerText` всей матрицы

Имя должно быть коротким и стабильным, например `Шаблоны — icon`, `nameSource: nearby-text` (или оставь `nearby-header`, если расширишь header до columnheader). `kind: icon-control`.

Если локального текста нет — по-прежнему `return null`. Безликие кнопки в каждой строке таблицы не должны взорвать snapshot.

Приоритет: как сейчас, semantic = 1, header-icon = 2, toolbar-icon с соседним текстом = 3. Table cap 20 не применяется к тулбару вне таблицы; если кнопка внутри `table` но в `thead`/header row — header побеждает строки.

## Обязательные тесты

Добавь fixture (в `test/browser.test.ts` или lab fixture), не живой Atlas:

1. Тулбар: кнопка «Шаблоны» + соседний `<button><img></button>` без имени. Snapshot содержит `icon-control` с `ref` и именем, из которого понятно соседство с Шаблоны. Click по этому `ref` меняет DOM наблюдаемо (открой popup / поставь `data-open`).
2. Старая лупа в `th` («Product code») по-прежнему находится и кликается.
3. Таблица на 100 строк не даёт больше 20 row-targets; общий cap ≤ 60; `interactiveTruncated` / `omittedCount` честные.
4. Кнопка без имени и без соседа по-прежнему не попадает в interactive.
5. Сырой SVG / голая ячейка `td` не становятся targets.

Живой Atlas не является unit-гейтом. После зелёных тестов один `qa run` только `B2B-006` (или весь `packs/b2b-login`, если ключ OpenRouter живой). Успех: не BLOCKED capability и не «нет ref». Не выбирать чекбоксы колонок.

`B2B-005` (expand «Вина») в удачном прогоне уже PASS. `B2B-008` упирался в лимит ключа — не маскируй это правкой рук.

## Definition of Done

- [ ] безымянная тулбар-иконка рядом с подписью получает `ref`
- [ ] WineLab-лупа и cap 60/20 зелёные
- [ ] безликие table-cell кнопки не хлынули в snapshot
- [ ] `bun test` и `bun run typecheck` зелёные
- [ ] по возможности живой `B2B-006` больше не capability-block
- [ ] коммит отдельно, без `.omc/`, без `.qa/`
