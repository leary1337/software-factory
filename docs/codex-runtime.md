# Codex через подписку ChatGPT

Роли `implementer`, `reviewer`, `rework`, `planner`, `nightwatch`,
`bugwatch`, `pr-fixer` и `healer` запускают `codex exec --json` в
локальном runtime Warren. Модель по умолчанию — `gpt-6.1-sol`. Claude Code
остаётся отдельным явно выбираемым профилем `claude-code`. Pi доступен только
для чтения истории; новые запуски с ним отклоняются.
Служебные роли не используют их: планы патрулей передаются `implementer`,
CI-fixer выбирает `pr-fixer`, обработчик алертов — `healer`.
Явные переопределения ролей и моделей в конфигурации проекта сохраняются;
при переходе проверь `triggers`, `ciFixer.role`, `healer.role`,
`interactiveAgents.plannerRuntime`, `defaultProvider` и `defaultModel`.

## Настройка на macOS

1. Установи Codex CLI и проверь `codex --version`. Для этого перехода проверена
   версия `0.167.0-alpha.3.2` из приложения Codex.
2. Выполни вход из той же учётной записи macOS, которая запускает Warren:

   ```sh
   codex login -c 'cli_auth_credentials_store="file"'
   codex login status
   ```

   Выбери ChatGPT. Файловое хранение нужно потому, что Keychain основного
   пользователя недоступен из изолированного HOME агента.
3. Оставь `WARREN_RUNTIME=local` и
   `WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS=1`. Запусти Warren обычной командой
   `bun src/cli/main.ts up`. Его GitHub-токен остаётся отдельной настройкой.
4. Запускай план с `--agent implementer`. Встроенные роли обновляются при
   старте сервера. Ранее переопределённые пользователем роли сохраняются;
   проверь их runtime и model отдельно.

Источник авторизации: `WARREN_CODEX_AUTH_FILE`, иначе `auth.json` внутри
`CODEX_HOME`, иначе `~/.codex/auth.json`. Сам файл и его содержимое нельзя
коммитить или включать в логи. Warren копирует только авторизацию в приватный
HOME запуска с правами 0600, без личной конфигурации, плагинов и истории.

После выхода процесса Warren сохраняет обновлённые токены, если аккаунт и
исходный файл ещё совпадают, затем удаляет временную копию. Один сервер не
выдаёт один файл двум одновременным запускам. Используй одного владельца
обновления токенов: отдельный файловый вход для фабрики и один сервер Warren;
не дели этот файл между серверами или параллельными личными CLI-сессиями.

Режим авторизации принудительно установлен в ChatGPT, переменные ключей API
очищены. Недействительный вход останавливает запуск; API-оплата автоматически
не включается. Если вход истёк, повтори `codex login` между запусками.

## Обычный процесс на Mac

Фабрика запускает обычные процессы на текущем Mac:

```sh
export WARREN_RUNTIME=local
export WARREN_DATA_DIR="$HOME/Library/Application Support/Warren"
export WARREN_AUTOMATIC_MAX_CONCURRENT_RUNS=1
bun src/cli/main.ts up
```

Системный sandbox-режим удалён. Старое значение `WARREN_LOCAL_EXECUTION=sandbox`
отклоняется с объяснением; `process` можно убрать из окружения. Поддерживается
macOS и Codex, включая роли исполнителя и ревьюера. Linux/VPS и подключение
Claude Code отложены; исторические данные остаются доступны.

При необходимости задай `WARREN_CODEX_BIN` абсолютным путём к Codex CLI.
Без него бинарный файл ищется в PATH, как раньше. Источник ChatGPT-авторизации
настраивается через `WARREN_CODEX_AUTH_FILE`; механизм временной выдачи и
сохранения обновлённых токенов остаётся общим для обоих режимов.

Каждый запуск по-прежнему получает отдельную рабочую копию Git и HOME.
Задачи проходят обычный dispatch, события, отмену и таймауты; проверка ревьюера
исполняется в отдельной копии зафиксированного коммита. Guardian завершает
группу процессов при отмене, таймауте, выходе агента и потере сервера.
Повторный запуск автоматически этим режимом не создаётся.

Системной песочницы, принудительных лимитов CPU/RAM и сетевого allowlist нет.
Старые sandbox/network/resource настройки не создают ограничений ОС.
Preview запускается обычным процессом с отдельным guardian; отмена и удаление
задачи дожидаются его завершения, не затрагивая процессы других задач.
`doctor`, `/readyz` и подключение проекта не запускают sandbox-exec/bwrap.

## Навыки и сеть

Пакет навыков копируется в `$HOME/.agents/skills`, pstack — в
`$HOME/.agents/pstack`. Роли читают Codex-инструкцию перед pstack; ссылки на
Claude-инструменты исполняются через доступные инструменты Codex. Подагенты
используются, только если текущий CLI их предоставляет; иначе ревью проходит
последовательно с указанием этого ограничения.

Внутренняя песочница Codex CLI отключена для согласованного доверенного запуска.
Сеть открыта; дополнительные инструменты настраиваются общим набором фабрики.

## Остановка и восстановление

Перед обновлением со старой версии дождись завершения её активных запусков.
У старых manifest нет данных контроля процесса: новая версия отказывается
автоматически удалять такой workspace и требует ручного восстановления.

SIGINT/SIGTERM останавливают приём запросов и координатор, отключают мосты
событий, затем останавливают локальные агентские процессы и дожидаются
сохранения credentials. На macOS отдельный контролирующий процесс также
останавливает группу агента при аварийном завершении сервера (SIGKILL).
Это не resume модельной сессии: после рестарта незавершённый запуск получает
`sandbox_run_lost`, а сохранённая отмена — `cancelled`.

Перед удалением прерванного или грязного workspace Warren записывает
`$WARREN_DATA_DIR/recovery/<runId>.bundle`. Внутри есть ветка
`warren-recovery` с коммитами и снимком отслеживаемых и неигнорируемых новых
файлов. Снимок не меняет ветку на GitHub. `salvagePath` запуска и событие
`reap.workspace_destroyed` содержат путь; GC сохраняет bundle в том же каталоге.
Восстановить его можно в новую папку:

```sh
git clone -b warren-recovery /path/to/data/recovery/run_id.bundle recovered-work
```

Игнорируемые файлы (например, зависимости), исходное разделение index/worktree
и сессия модели не входят в снимок. Bundle не удаляется автоматически;
удали его после проверки восстановленной работы. Если архивирование или
проверка Git metadata не удалась, Warren сохраняет исходный workspace и
публикует ошибку удаления. Не удаляй его до ручного восстановления.

Журнал credentials хранится вне приватного HOME и не содержит токены.
Отдельный путь не является ограничением доступа ОС.
При следующем восстановлении runtime проверяет окончание процесса, аккаунт
и исходный auth-файл, сохраняет обновление и удаляет временные credentials.
Если запись не удалась, журнал и временный auth-файл остаются на диске.
Один источник авторизации по-прежнему должен иметь одного владельца.

Проверены SIGTERM и SIGKILL сервера на macOS. Потеря питания и принудительное
завершение самого контролирующего процесса не проверены: если окончание
песочницы не подтверждено, восстановление отказывается удалять workspace.

## Учёт и ограничения

- Warren сохраняет статистику токенов без пересчёта в деньги.
- Таймаут по умолчанию — 20 минут на запуск. Явный лимит runtime его заменяет.
- Модель можно заменить через `WARREN_CODEX_MODEL` при старте либо override
  при dispatch. Таблица цен для выбора модели не требуется.
- Steering передаётся при старте. Интерактивное управление ходом и resume
  модельной сессии не реализованы; восстановление файлов описано выше.
- Проверенный режим — локальный macOS. Docker и Linux с новым адаптером не
  прошли сквозную проверку; контейнерная поставка Codex требует отдельной работы.

Контракты OpenAI: [авторизация](https://developers.openai.com/codex/auth),
[неинтерактивный режим](https://developers.openai.com/codex/noninteractive).

### Project environment preparation

Project settings expose a preparation recipe, an optional command, a timeout,
and tool versions or absolute executable paths. Operator settings override the
repository defaults in `.warren/config.yaml`. Each agent checkout and each
independent verification checkout runs preparation separately. Download caches
are shared; installed `node_modules` and Python virtual environments are not.

Automatic detection supports an existing JavaScript lockfile, Python with uv.lock,
and Go modules. Multiple detected stacks require an explicit recipe or command.
JavaScript uses its existing package manager with frozen installation; Python uses
`uv sync --frozen` in a private `.venv`; Go uses the selected toolchain and verifies
module downloads. Preparation does not migrate the application stack. A failed or
cancelled preparation stops that stage and records the environment error before
an agent can report success.
