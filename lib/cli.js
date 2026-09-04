// Точка входа команды package'а. Host передаётся явно: process-wide singleton'а нет,
// два host'а в одном процессе законны и независимы.

import { parseArgs } from 'node:util';
import { fail } from './util.js';
import { KNOCK_TEXT_MAX, PRUNE_DEFAULT_DAYS } from './contract.js';

const SUBCOMMANDS = 'spawn, review, status, done, dismiss, history, prune, guard, warden, mcp';

export function helpText(host) {
  const cmd = host.commandName;
  return `Promptobus — шина сессий агентов

Использование: ${cmd} <команда>
Справка: ${cmd} help (то же — без команды, --help, -h) · версия: ${cmd} --version (-v)

  ${cmd} review <путь> [--task <id> | --title <имя>] [--base <ref>] [--model <m>] [--effort <e>]
            [--permission-mode <p>] [--harness <h>] [--dry-run]
                              изолированное ревью изменений репозитория: reviewer — фоновая
                              сессия на шине Promptobus, read-only; diff — предмет;
                              путь обязателен — резолва по текущему каталогу нет;
                              без --task задачу выбирает сам каталог: числится worktree
                              участника активной задачи — берётся она, не числится нигде —
                              заводится своя задача ревью; --task <id> сильнее обоих и
                              повторным вызовом шлёт reviewer'у новый дифф
  ${cmd} spawn --repo <имя|путь> --brief <файл> [--task <id> | --new-task] [--title <t>] [--task-title <t>]
            [--slug <s>] [--worker <имя>] [--model <m>] [--effort <e>] [--permission-mode <p>]
            [--harness <h>] [--dry-run]
                              поднять worker'а — сессию в директории репозитория,
                              подключённую к шине Promptobus (запускать только с аппрува);
                              --harness обязан быть объявлен в манифесте инструментов рабочего места;
                              --title — заголовок КУСКА работы; --task-title — заголовок ЗАДАЧИ;
                              без --task spawn подсаживает worker'а в единственную активную задачу;
                              --new-task заводит отдельную задачу
  ${cmd} status [--task <id>]
                              активные задачи: участники, непрочитанное, состояние сессий
  ${cmd} done [--task <id>] [--keep-sessions]
                              закрыть задачу (переписка остаётся журналом); закрывает её
                              владелец mailbox'а. Сессии, поднятые механизмом, команда гасит
                              сама — --keep-sessions оставляет их живыми.
                              Последним ходом сносит журналы задач, закрытых раньше
                              ${PRUNE_DEFAULT_DAYS} дн. (порог и проба — ${cmd} prune)
  ${cmd} dismiss <адрес> [--task <id>]
                              снять сданного участника с наблюдения. Снимает владелец
                              mailbox'а задачи; уже отправленные доклады не отзываются
  ${cmd} history [--task <id>] [--participant <адрес>] [--limit <n> | --all]
                              журнал ПРОЧИТАННОЙ переписки, от старых записей к новым;
                              по умолчанию последние 50, --limit меняет число, --all
                              снимает лимит; прочитанным команда не делает ничего
  ${cmd} prune [--older-than <дней>] [--yes]
                              снести журналы давно закрытых задач;
                              по умолчанию проба: печатает, что уйдёт, и не удаляет ничего;
                              удаляет только --yes; порог возраста ${PRUNE_DEFAULT_DAYS} дн.
  ${cmd} guard [--role <адрес>] [--task <id>] [--home <путь>]
                              сторож цикла: не даёт сессии кончить ход с непрочитанным
                              mailbox'ом. Зовёт его Stop-хук layout'а; чисто — молчит и
                              выходит нулём, иначе возвращает ход кодом 2
  ${cmd} warden [--task <id>]
                              надзиратель задачи: единственный её слушатель и будильник.
                              Заметив непрочитанное, будит адресата и несёт текст коротких
                              сообщений (до ${KNOCK_TEXT_MAX} знаков); прочитанными их делает mailbox.
                              Поднимает его любая команда шины; PROMPTOBUS_WARDEN=off гасит автоподъём
  ${cmd} mcp
                              stdio MCP-сервер шины
`;
}

function parse(name, args, { options = {}, positionals = 0 } = {}) {
  const known = Object.keys(options).map((f) => `--${f}`).join(', ');
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true });
    if (parsed.positionals.length > positionals) {
      const limit = ['не принимает аргументов', 'принимает не больше одного аргумента', 'принимает не больше двух аргументов'][positionals]
        ?? `принимает не больше ${positionals} аргументов`;
      fail(`${name}: лишний аргумент «${parsed.positionals[positionals]}» — команда ${limit}`);
    }
    return parsed;
  } catch (e) {
    if (!String(e?.code ?? '').startsWith('ERR_PARSE_ARGS_')) throw e;
    fail(`${name}: ${e.message}\n  известные флаги: ${known || '(у этой команды флагов нет)'}`);
  }
}

function writeLine(stream, text) {
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  if (typeof stream.write === 'function') stream.write(chunk);
  else console.log(text);
}

export async function runPromptobus(argv, { host, cwd, env, input, output } = {}) {
  if (!host || typeof host.commandName !== 'string') {
    throw new TypeError('runPromptobus: нужен host');
  }
  cwd = cwd ?? process.cwd();
  env = env ?? process.env;
  input = input ?? process.stdin;
  output = output ?? process.stdout;

  const args = [...(argv ?? [])];
  if (args[0] === host.commandName) args.shift();
  const [cmd, ...rest] = args;
  const at = (sub) => `${host.commandName} ${sub}`.trim();

  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        writeLine(output, helpText(host));
        return 0;
      case '--version':
      case '-v':
        writeLine(output, `${host.commandName} ${host.version}`);
        return 0;
      case 'mcp': {
        parse(at('mcp'), rest);
        await (await import('./server.js')).serve({ host, env, cwd, input, output });
        return 0;
      }
      case 'warden': {
        const { values } = parse(at('warden'), rest, { options: { task: { type: 'string' } } });
        await (await import('./warden.js')).warden({ ...values, host }, env, cwd);
        return 0;
      }
      case 'guard': {
        const { values } = parse(at('guard'), rest, {
          options: { role: { type: 'string' }, task: { type: 'string' }, home: { type: 'string' } },
        });
        await (await import('./guard.js')).guard({ ...values, host }, env, cwd, input);
        return 0;
      }
      case 'review': {
        const { values, positionals } = parse(at('review'), rest, {
          options: {
            base: { type: 'string' },
            task: { type: 'string' },
            title: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            'permission-mode': { type: 'string' },
            harness: { type: 'string' },
            'dry-run': { type: 'boolean' },
          },
          positionals: 1,
        });
        await (await import('./review.js')).review(host, {
          target: positionals[0],
          base: values.base,
          task: values.task,
          title: values.title,
          model: values.model,
          effort: values.effort,
          permissionMode: values['permission-mode'],
          harness: values.harness,
          dryRun: values['dry-run'],
        });
        return 0;
      }
      case 'prune': {
        const { values } = parse(at('prune'), rest, {
          options: { 'older-than': { type: 'string' }, yes: { type: 'boolean' } },
        });
        (await import('./prune.js')).prune(host, {
          olderThan: values['older-than'],
          yes: values.yes,
        });
        return 0;
      }
      case 'dismiss': {
        const { values, positionals } = parse(at('dismiss'), rest, {
          options: { task: { type: 'string' } },
          positionals: 1,
        });
        (await import('./dismiss.js')).dismiss(host, {
          address: positionals[0],
          task: values.task,
        });
        return 0;
      }
      case 'history': {
        const { values } = parse(at('history'), rest, {
          options: {
            task: { type: 'string' },
            participant: { type: 'string' },
            limit: { type: 'string' },
            all: { type: 'boolean' },
          },
        });
        (await import('./history.js')).history(host, values);
        return 0;
      }
      case 'spawn': {
        const { values } = parse(at('spawn'), rest, {
          options: {
            repo: { type: 'string' },
            brief: { type: 'string' },
            task: { type: 'string' },
            'new-task': { type: 'boolean' },
            title: { type: 'string' },
            'task-title': { type: 'string' },
            slug: { type: 'string' },
            worker: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            'permission-mode': { type: 'string' },
            harness: { type: 'string' },
            'dry-run': { type: 'boolean' },
          },
        });
        await (await import('./spawn.js')).spawn(host, {
          ...values,
          dryRun: values['dry-run'],
          newTask: values['new-task'],
          permissionMode: values['permission-mode'],
          taskTitle: values['task-title'],
        });
        return 0;
      }
      case 'status': {
        const { values } = parse(at('status'), rest, { options: { task: { type: 'string' } } });
        const { status } = await import('./status.js');
        status(host, values);
        return 0;
      }
      case 'done': {
        const { values } = parse(at('done'), rest, {
          options: { task: { type: 'string' }, 'keep-sessions': { type: 'boolean' } },
        });
        const { done } = await import('./done.js');
        await done(host, values);
        return 0;
      }
      default:
        fail(`${host.commandName}: неизвестная команда «${cmd ?? ''}» — ${SUBCOMMANDS}`);
    }
  } catch (e) {
    const expected = e?.status !== undefined
      || e?.constructor?.name === 'ResolveError'
      || e?.constructor?.name === 'GateError'
      || e?.constructor?.name === 'HostResolveError';
    if (!expected && e?.stack) console.error(e.stack);
    fail(e.message ?? String(e));
  }
  return 0;
}
