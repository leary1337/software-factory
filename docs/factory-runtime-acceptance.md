# Приёмка локального исполнения фабрики

Поток задач 02–04. Платформа: macOS; фабрика на VPS не изменялась.

## 02 — обычный процесс Codex

Изолированный HTTP smoke с отдельными SQLite, проектом и bare Git remote:
Codex CLI 0.169.0-alpha.11.1, модель gpt-6.1-sol. Обычный dispatch завершился
succeeded; второй dispatch отменён через HTTP, процесс больше не существовал.
Сервер остановлен. Авторизация выдавалась существующим lifecycle, без ручного
копирования токенов. Доказательства: `/tmp/factory-ticket02-smoke-evidence.json`
и `/tmp/factory-ticket02-smoke.log`.

## 03 — независимая проверка

Проверены зафиксированный SHA, чистые исходники при грязных копиях агента и
host clone, отдельные HOME и зависимости, отказ при изменении проверяемых
файлов и ненулевом коде, отмена и таймаут с завершением descendants.
Существующие тесты merge-proof и UI summary подтверждают связь результата
с SHA и запрет merge без машинного доказательства.

30 тестов в 5 файлах прошли: `/tmp/factory-ticket03-tests.log`.
Новая матрица: `src/runtime/local/quality-gate-process.test.ts`.

## 04 — вспомогательные процессы

Потребители прежнего OS spawn: агент, independent gate, preview sidecars,
Git preflight подключения проекта, CLI up/doctor и readyz. Все переведены на
обычные процессы или избавлены от проверки удалённой зависимости. Исполнители
bwrap/Seatbelt, cgroup и sandbox network proxy удалены вместе с тестами именно
удалённых гарантий. Нейтральные guardian, IO, environment и Git-integrity
проверки сохранены; исторические sandbox failure markers читаются.

Preview cancellation дожидается exited, завершает descendants только своего
запуска; отдельные маркеры позволяют recovery дождаться всех preview writers.
Реальные тесты подтверждают сохранение соседнего процесса и ожидание маркеров.
Нативные тесты private-Git finalization и SIGTERM/SIGKILL recovery прошли.

Батчи проверки (пересекаются): 110 тестов/15 файлов —
`/tmp/factory-ticket04-tests.log`; 33 теста/4 файла —
`/tmp/factory-ticket04-sidecars.log`; 26 тестов/2 файла —
`/tmp/factory-ticket04-config.log`.

LocalProvider теперь всегда использует process execution на Mac. Старый
sandbox selector отклоняется; Linux остаётся явно неподдерживаемым этапом.
Полные repository gates и UI приёмку выполняет интегрирующий агент на общей
финальной версии. Новая рабочая установка пока не обновлялась этим потоком.

## 17–19 — подготовка рабочих копий

Рецепт хранится в durable project settings поверх `.warren/config.yaml`:
`preparation.recipe` (`auto`, `command`, `javascript`, `python-uv`, `go`),
`command`, `timeoutMs`, `tools.<name>.version/executable`. По умолчанию стек
определяется по manifest; неоднозначный стек требует выбора рецепта или команды.
Исполнитель и независимая проверка запускают одну реализацию подготовки в своих
копиях. Исполнитель получает авторизацию CLI только после успешной подготовки.

JavaScript использует существующий lockfile и менеджер, frozen install и
`packageManager` pin. Python требует существующие pyproject.toml и uv.lock,
запускает uv sync --frozen и создаёт отдельную .venv. Go использует версию из
рецепта или go.mod/toolchain, затем mod download/verify. Произвольные установленные
node_modules/.venv между копиями не копируются; общие только штатные кеши менеджеров.
Абсолютные executable overrides и проверки версий позволяют задать инструменты
проекта. Отсутствующий инструмент получает понятную ошибку подготовки.

Фабрика пишет preparation.started/completed/failed с этапом agent/verification,
хешем входов и длительностью. Произвольные сообщения агента с этим префиксом
не принимаются как доказательства. Ошибка подготовки классифицируется как ошибка
окружения, а не молчание модели. Есть таймаут и отмена с guardian teardown.

Проверки: `/tmp/factory-preparation-tests.log` — 37 тестов/5 файлов;
`/tmp/factory-preparation-stacks.log` — 2 реальных сценария uv/Go;
`/tmp/factory-preparation-failures.log` — lifecycle и классификация ошибок.
Реальные сценарии подтверждают разные uv environments, смену зависимости,
сохранение прежней копии, неудачную установку, Go toolchain и отсутствие инструмента.
Отдельный тест gate выполняет подготовку перед проверкой закреплённого SHA.
UI сохранения рецепта и отображения состояния проверяется потоком интерфейса.
