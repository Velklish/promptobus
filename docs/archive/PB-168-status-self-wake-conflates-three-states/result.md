# PB-168 · Result

**Исход:** закрыта.

**Что сделано.** Warden пишет на health-метку `selfWake` (`starting` / `taken` / `refused`) и `selfWakeChannel` во всех трёх ветках отката в `src/supervisor.ts` и чистит их на успешном стуке. `lib/status.js` получил `SELF_WAKE_PROGNOSIS` и `selfWakeSuffix`, так что каждое состояние печатает свой прогноз, а не общую метку.

**Чем проверено.** `test/promptobus-warden.test.mjs`: `:271` «the start-up fallback records its own state, and no channel refused anything», `:300` «a refusing channel records the refusing state and the channel that refused», `:1971` «a hijacked contact point records the taken state, and names no channel», `:2033` «every one of the five rows prints a self-wake line at all».

**Что осталось за карточкой.** В пятом круге нашлась четвёртая ветка: pull-участник штатно пишет `channel: 'pull'`, `wake: null` и не стучит никогда, а откат читал отсутствующий сокет как «только что стартовал» и обещал стук. Разобрано в той же карточке — pull судится до self-wake-отката, self-wake-поля чистятся при переходе; два check'а на `:2050` и `:2057`, проба: при выключенной ветке строка снова становится «alarm: self-wake — starting up; clears on the first knock». Эти два check'а помечены чужим номером — поправка 2.
