# FACTORY-REDESIGN: утверждённые задачи

Разбивка согласована владельцем 14 ноября 2026 года. Все 40 задач опубликованы локально с меткой `ready-for-agent`.

Исполнение: текущий Mac. VPS отложен. Владелец разрешил промежуточные локальные обновления после проверок. Итоговая приёмка обновления — задача 39.

| № | Задача | Блокеры | Метка |
|---|---|---|---|
| 01 | [Сохранить общую финализацию перед очисткой](issues/01-shared-finalization.md) | Нет | ready-for-agent |
| 02 | [Запускать Codex обычным процессом на Mac](issues/02-local-process.md) | Нет | ready-for-agent |
| 03 | [Проверять чистый коммит без песочницы](issues/03-independent-gate.md) | 02 | ready-for-agent |
| 04 | [Завершить переход вспомогательных процессов](issues/04-auxiliary-processes.md) | 02, 03 | ready-for-agent |
| 05 | [Удалить Docker-runtime и старые контейнерные входы](issues/05-remove-docker.md) | 01 | ready-for-agent |
| 06 | [Удалить Pi из доступного исполнения](issues/06-remove-pi.md) | Нет | ready-for-agent |
| 07 | [Удалить автоматические патрули](issues/07-remove-patrols.md) | Нет | ready-for-agent |
| 08 | [Убрать внешние трекеры и отдельные расширения](issues/08-remove-integrations.md) | Нет | ready-for-agent |
| 09 | [Показывать одну понятную задачу](issues/09-task-card.md) | Нет | ready-for-agent |
| 10 | [Собрать планы и выпуски внутри проекта](issues/10-project-workspace.md) | Нет | ready-for-agent |
| 11 | [Оставить три раздела интерфейса](issues/11-simple-navigation.md) | 09, 10 | ready-for-agent |
| 12 | [Выбирать исполнителя и ревьюера отдельно](issues/12-execution-profiles.md) | Нет | ready-for-agent |
| 13 | [Доставлять одну версию общего набора навыков](issues/13-shared-skills.md) | Нет | ready-for-agent |
| 14 | [Подключить бесплатные Exa и Context7](issues/14-free-search-docs.md) | 02, 13 | ready-for-agent |
| 15 | [Добавить локальный Graphify](issues/15-local-graphify.md) | 02, 13 | ready-for-agent |
| 16 | [Дать агентам общий Playwright](issues/16-browser-tools.md) | 02, 13 | ready-for-agent |
| 17 | [Готовить проект командой и рецептом JavaScript](issues/17-prepare-js.md) | 02, 03 | ready-for-agent |
| 18 | [Готовить Python/uv-проект](issues/18-prepare-python.md) | 17 | ready-for-agent |
| 19 | [Готовить Go-проект](issues/19-prepare-go.md) | 17 | ready-for-agent |
| 20 | [Запускать сохранённую версию плана](issues/20-approved-snapshot.md) | 12, 13 | ready-for-agent |
| 21 | [Явно менять оставшуюся часть плана](issues/21-revise-plan.md) | 20 | ready-for-agent |
| 22 | [Обновлять инструментарий без изменения активных планов](issues/22-update-toolkit.md) | 20 | ready-for-agent |
| 23 | [Ограничивать задачу и доработку по прогрессу](issues/23-task-budgets.md) | 20 | ready-for-agent |
| 24 | [Повторять только исправимую подготовку](issues/24-repair-environment.md) | 17, 23 | ready-for-agent |
| 25 | [Сверять результат PR, merge и deploy перед повтором](issues/25-reconcile-effects.md) | 20 | ready-for-agent |
| 26 | [Восстанавливать реализацию, ревью и доработку](issues/26-recover-runs.md) | 03, 23, 25 | ready-for-agent |
| 27 | [Разрешать обычный merge и проверять особые изменения](issues/27-merge-permissions.md) | 20 | ready-for-agent |
| 28 | [Выпускать приложение на границах плана](issues/28-release-boundaries.md) | 20, 25 | ready-for-agent |
| 29 | [Подтверждать версию и пользовательский сценарий](issues/29-verify-release.md) | 28 | ready-for-agent |
| 30 | [Возвращать и проверять последнюю рабочую версию](issues/30-safe-rollback.md) | 29 | ready-for-agent |
| 31 | [Исправлять неудачный выпуск в бюджете исходной задачи](issues/31-repair-release.md) | 23, 26, 30 | ready-for-agent |
| 32 | [Подключать существующий репозиторий с проверкой готовности](issues/32-project-readiness.md) | 12, 17, 29 | ready-for-agent |
| 33 | [Создавать проект с согласованным стеком](issues/33-new-project.md) | 32 | ready-for-agent |
| 34 | [Скрыть обслуживание Seeds и сделать память опцией](issues/34-tracker-memory.md) | Нет | ready-for-agent |
| 35 | [Восстанавливать локальное состояние с одним владельцем](issues/35-backup-single-owner.md) | 26 | ready-for-agent |
| 36 | [Сохранять работу при закрытии локального интерфейса](issues/36-local-client.md) | 02, 09 | ready-for-agent |
| 37 | [Проверить чистую установку минимальной фабрики](issues/37-minimal-install.md) | 04, 05, 06, 07, 08, 13, 17 | ready-for-agent |
| 38 | [Пройти полную локальную приёмку](issues/38-local-acceptance.md) | 11, 14, 15, 16, 18, 19, 21, 22, 24, 27, 31, 33, 34, 35, 36, 37 | ready-for-agent |
| 39 | [Обновить рабочую фабрику на этом Mac](issues/39-local-upgrade.md) | 38 | ready-for-agent |
| 40 | [Провести малый пилот из локальной фабрики](issues/40-hockey-pilot.md) | 39 | ready-for-agent |

Состояние исполнения и доказательства ведутся отдельно от метки готовности; блокирующие задачи должны быть завершены до старта зависимой.
