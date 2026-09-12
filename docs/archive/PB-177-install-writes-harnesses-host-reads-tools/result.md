# PB-177 · Result

**Исход:** закрыта.

**Что сделано.** `install` записывал `harnesses`, а standalone-host читал `tools`, поэтому сразу после успешной установки `review` отказывал. Успешная установка теперь прямо говорит, что `tools` остался необъявленным, а текст отказа объясняет, почему хорошая установка его не удовлетворила, — вместо отказа, который выглядел как сломанная установка.

**Чем проверено.** `test/hooks.test.mjs`: «PB-177: a successful install says that tools is still undeclared, and the refusal says why» и «PB-177: with tools declared, install is silent about it and the harness lifts».

**Что осталось за карточкой.** Ничего.
