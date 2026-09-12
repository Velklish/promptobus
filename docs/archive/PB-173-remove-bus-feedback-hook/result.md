# PB-173 · Result

**Исход:** закрыта (кроме README обоих языков — их перебрал ты).

**Что сделано.** `PostToolUse` feed hook убран: из `src/hooks.ts` сняты `BUS_HOOK_EVENT`, `BUS_HOOK_MATCHER`, `busHookSettings`, `busHookCommand`; удалён `templates/bus-hook.mjs`; `lib/install.js` его больше не пишет и вынимает тот, что оставила старая установка, узнавая его по пути раннера `.promptobus/hooks/bus.mjs`, который команда всё ещё называет, и удаляя скрипт вместе с записью. Рабочая механика через хук не шла: ход возвращает Stop-guard, счётчики непрочитанного едут в самом MCP-ответе, доставка участнику — дело warden'а по его каналу.

**Чем проверено.** `test/hooks.test.mjs:72` «PB-173: install writes no feed hook for any harness, and no runner script» и `:95` «PB-173: a feed hook an older install wrote is taken out, and a foreign hook beside it is not». Отдельным коммитом (`f23292b`) выправлены пять тестов `install.test.mjs`, которые несли feed hook в ожиданиях.

**Что осталось за карточкой.** README обоих языков — не я. И каталог `templates`: снят из индекса, но на него ходили `test/boundary.test.mjs` и `package.json`; это и стало одним из двух дефектов сведения — поправка 1.
