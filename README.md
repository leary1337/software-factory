# Software Factory

Личная фабрика кода: тикеты превращаются в проверенные PR, а последнее слово всегда за человеком. Агенты работают на Mac владельца, через Codex CLI на подписке ChatGPT, каждый запуск изолирован в песочнице.

Это форк [Warren](https://github.com/jayminwest/warren) 0.19.3 (MIT), автор которого прекратил поддержку. Это не проект Warren и не сервис warren.run. Навыки агентов взяты из [pstack](https://github.com/cursor/plugins/tree/main/pstack) и [skills Мэтта Пококка](https://github.com/mattpocock/skills). Решения и история сборки записаны в [docs/PLAN.md](docs/PLAN.md).

## Как идёт работа

```mermaid
flowchart TD
    idea(["Идея или задача"]) --> station

    subgraph session["Твоя сессия Codex"]
        station["<b>Постановка</b><br/>Ты + модель на выбор<br/>grilling, to-spec, to-tickets"]
    end

    station --> tickets[("Тикеты в Seeds")]
    tickets --> start["Ты запускаешь план<br/>warren plan run --agent implementer"]

    subgraph warren["Warren: один запуск за раз, песочница, сеть по списку доменов"]
        impl["<b>implementer</b> · GPT-6.1 Sol<br/>Делает один тикет<br/>и проходит qualityGate"]
        pr["Warren пушит ветку<br/>и открывает PR"]
        review["<b>reviewer</b> · GPT-6.1 Sol<br/>Читает PR без контекста реализации"]
        verdict{"Вердикт"}
        rework["<b>rework</b> · GPT-6.1 Sol<br/>Правит только названное ревьюером"]
        comment["Warren публикует итог<br/>комментарием в PR"]
        merge["Warren публикует итог<br/>и сливает PR"]

        impl --> pr --> review --> verdict
        verdict -- "CHANGES, доработок меньше 2" --> rework
        rework -- "та же ветка" --> review
        verdict -- "PASS" --> merge
        verdict -- "CHANGES после 2 доработок<br/>или сбой ревью" --> comment
    end

    start --> impl
    comment --> human{"Ты читаешь PR"}
    human -- "слить" --> close["Warren закрывает тикет"]
    human -- "закрыть без слияния" --> stop(["План останавливается"])
    merge --> close
    close --> next{"Есть ещё тикеты?"}
    next -- "да" --> impl
    next -- "нет" --> done(["План завершён"])
```

Следующий тикет стартует после слияния предыдущего PR. Если проект включил автоматический deploy, он также ждёт проверки production. После вердикта `PASS` Warren сливает PR сам, если включены `WARREN_PLAN_RUN_MERGE_ON_PASS=1` и проектный `pr.autoMerge`, а проверка безопасности разрешила изменения. Если замечания остались или ревью сорвалось, PR ждёт тебя. Runtime независимо исполняет quality gate на закреплённом коммите. Изменения интерфейса проходят отдельное UI/UX-ревью. [Обязательные ограничения merge](docs/factory-merge-safety.md) действуют поверх политики проекта.

## Агенты цепочки

| Агент | Где работает | Модель | Цель | Суть работы | Навыки |
|---|---|---|---|---|---|
| Постановка | Твоя сессия | На твой выбор | Превратить идею в понятные тикеты | Допрашивает тебя, фиксирует термины, пишет спецификацию и режет её на тикеты | `grilling`, `domain-modeling`, `to-spec`, `to-tickets`, `wayfinder`, `prototype` |
| `implementer` | Песочница Warren | GPT-6.1 Sol | Сделать один тикет | Следует подходящему сценарию pstack, пишет код и тесты, проходит `qualityGate`, коммитит | `poteto-mode`, `architect`, `typescript-best-practices`, `tdd`, `diagnosing-bugs`, `codebase-design`, `go-best-practices` |
| `reviewer` | Песочница Warren | GPT-6.1 Sol | Независимо проверить PR | Сверяет diff с тикетом и стандартами, пытается сломать код, ищет дефекты безопасности, ничего не меняет | `code-review`, `interrogate`, `blast-radius` |
| `rework` | Песочница Warren | GPT-6.1 Sol | Закрыть замечания ревью | Подтверждает каждое замечание и вносит минимальную правку в ту же ветку. Запускается не больше 2 раз на PR | `diagnosing-bugs`, `go-best-practices` |

Остальные роли Warren (`claude-code`, `planner`, `pr-fixer`, `healer`, `nightwatch`, `bugwatch`) есть в реестре, но в цепочке не участвуют. `planner`, `pr-fixer`, `healer`, `nightwatch` и `bugwatch` тоже настроены на Codex. Роль `claude-code` сохраняет собственный адаптер. Pi недоступен для новых запусков. Его прежние журналы остаются читаемыми.

## Запуск

Нужны macOS, [Codex CLI](https://developers.openai.com/codex/cli) с входом через ChatGPT, `gh`, Go 1.25, `golangci-lint` и:

```bash
npm i -g bun@1.3.14 @os-eco/seeds-cli@0.5.13 @os-eco/mulch-cli@0.10.7
```

Сначала войди в Codex с файловым хранением авторизации:

```bash
codex login -c 'cli_auth_credentials_store="file"'
codex login status
```

Warren использует только вход ChatGPT. Подробности авторизации, моделей и ограничений: [инструкции Codex](docs/codex-runtime.md).

Установка фабрики:

```bash
bun install --frozen-lockfile && bun run build:ui
```

Запуск сервера с интерфейсом на `localhost:8080`. При первом старте мастер использует существующий вход Codex и запросит GitHub-токен. Выдавай токен только на нужные репозитории и не соглашайся использовать токен `gh`:

```bash
bun run factory:start
```

Пресет выбирает local runtime, один автоматический запуск, merge после PASS и ожидание слияния без таймаута. Настройки доступа загружаются обычным механизмом Warren. Для уже настроенной установки: `bun run factory:start --no-open --no-wizard`.

При Ctrl-C Warren останавливает локальные jobs и сохраняет credentials. После рестарта прерванная работа сохраняется в Git bundle. Модельная сессия не продолжается. См. [остановку и восстановление](docs/codex-runtime.md#остановка-и-восстановление).

## Работа с проектом

1. Открой сессию Codex в корне фабрики и вызови `$connect-project`, указав путь к проекту или новую идею. Механика доступна отдельно: `bun scripts/connect-project.ts --help`.
2. Добавь репозиторий в GitHub-токен Warren.
3. В той же сессии подготовь спецификацию через `$to-spec` и тикеты Seeds через `$to-tickets`, явно указав целевой проект. [Закреплённые навыки постановки и ретроспективы](factory/skill-pack/owner/README.md) доступны через `.agents/skills/`.
4. Запусти тикеты по порядку:

```bash
bun src/cli/main.ts plan run --project <prj_id> --agent implementer --issues <id1,id2>
```

5. Разбирай PR, которые ревью или политика безопасности не пропустили. Автослияние требует явного `pr.autoMerge` в default branch проекта, подключение само его не включает.

В Plan runs название тикета открывает общую карточку задачи: реализация, ревью,
доработки, вердикт и следующее действие. Технический журнал каждого run доступен из неё.

Production показывает текущий релиз и отдельную историю попыток. Автоматический
цикл после merge включается только настройками проекта и требует подготовленного
workflow: [инструкция](docs/production-delivery.md).

## Наблюдение за задачами

Главный экран: **Tasks**: задачи из планов собраны по состоянию, с поиском по
названию, проекту и плану. Карточка открывает всю цепочку реализации, ревью,
доработок и доставки. Она показывает причину остановки, следующее действие,
доказательства приёмки и суммарные показатели. При большом числе планов список
загружается порциями. Поиск работает по уже загруженным задачам.

Основная навигация: Tasks, Plans, Projects, Production и Settings.
Runs, Operations, Agents, Telemetry и Events находятся в **More**.
прежние прямые ссылки работают. Отдельные запуски вне плана остаются в Runs.

- [Доказательства приёмки](docs/acceptance-evidence.md): критерии тикета
  связываются с одобренными командами. Runtime сохраняет результаты и артефакты.
- [Метрики задачи](docs/factory-task-metrics.md): вся цепочка, включая повторы.
  Неизвестные измерения не превращаются в нули.
- [Бюджеты задачи и плана](docs/plan-run-budgets.md): ограничения всей цепочки
  перед следующим запуском, с сохранением расхода после рестарта.
- [Повторяемый пилот](docs/factory-pilot.md): отдельный тестовый репозиторий,
  отпечаток исходников и машинный отчёт о наблюдаемом результате.
- [Безопасность merge](docs/factory-merge-safety.md): проверенная ветка должна
  включать актуальную базу. Автослияние требует подтверждённой строгой защиты
  ветки GitHub без обхода администратором. Если она недоступна, PR ждёт ручного
  merge с явной причиной. Локальный gate сам по себе не устраняет гонку с
  изменением целевой ветки.

## Новые проекты

Шаблон лежит в [`factory/template`](factory/template): Go 1.25, React, TypeScript, Vite, Tailwind и компоненты в стиле shadcn/ui. Проверка качества одна: `scripts/check.sh`.

## Что где лежит

| Путь | Что там |
|---|---|
| [`factory/skill-pack`](factory/skill-pack) | Закреплённые копии навыков, версии в `LOCK.json` |
| [`factory/template`](factory/template) | Шаблон новых проектов |
| [`scripts/connect-project.ts`](scripts/connect-project.ts) | Механика подключения проектов |
| [`src/registry/builtins/factory-roles.ts`](src/registry/builtins/factory-roles.ts) | Промпты и модели агентов |
| [`src/plan-runs/review.ts`](src/plan-runs/review.ts) | Шаг ревью и доработки |

## Status

Stable (`0.19.3`): версия Warren, на которой основан форк. Ограничения:

- Лимиты подписки общие с другими сессиями Codex. Время работы ограничено 20 минутами по умолчанию.
- Запуск через Docker после удаления Kubernetes не проверялся, навыки туда не доставляются.
- Рабочий режим проверен только на macOS.

## Лицензия

MIT, см. [LICENSE](LICENSE).
