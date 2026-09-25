// Package command entry point. The host is passed in — no process-wide singleton, two hosts
// in one process are legal; the one exception is [`harnessStateHome`](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says).

import { parseArgs } from 'node:util';
import { GateError, PromptobusError } from '../dist/index.js';
import { HostResolveError } from '../dist/host.js';
import { fail } from './util.js';
import { KNOCK_TEXT_MAX, PRUNE_DEFAULT_DAYS } from './contract.js';
import { LEASE_WAIT_SEC } from './lease.js';
import { bindHarnessBins, bindHarnessHomes } from './harness-home.js';
import { resolveSessionIdentity } from './drivers.js';
import { bindSessionIdentity, bus } from './store.js';

const SUBCOMMANDS = 'spawn, review, models, status, done, sweep, dismiss, history, prune, guard, warden, mcp, install, uninstall, lease';
// `send` is not here on purpose: it resolves its own home and primes the store after the
// resolve, so priming the host's here would open a second one for nothing (PB-179 review).
const STORE_COMMANDS = new Set(['spawn', 'review', 'status', 'done', 'stop', 'sweep', 'dismiss', 'history', 'prune']);

export function helpText(host) {
  const cmd = host.commandName;
  return `Promptobus — a bus for agent sessions

Usage: ${cmd} <command>
Help: ${cmd} help (same as no command, --help, -h) · version: ${cmd} --version (-v)

  ${cmd} review <path> [--task <id> | --title <name>] [--base <ref>] [--model <m>] [--effort <e>]
            [--permission-mode <p>] [--harness <h>] [--strategy <s>] [--allow-payg] [--refresh] [--dry-run]
            [--approver]
                              isolated review of repository changes: the reviewer is a
                              background Promptobus session, read-only; the subject is the
                              diff; the path is required — there is no resolve from the
                              current directory; without --task the directory picks the
                              task: if it is listed as a participant worktree of an active
                              task, that task is used; if it is listed nowhere, a new
                              review task is opened; --task <id> overrides both, and a
                              repeat call sends the reviewer a new diff;
                              --approver with --task lifts an approver after a reviewer
                              result is on record for that piece — it does not start a
                              reviewer and does not judge the review;
                              --strategy lets the resolver pick the reviewer tuple —
                              --model, --effort and --harness stay constraints on it;
                              without --strategy the recorded workspace default
                              (promptobus models strategy) routes the call; only when no
                              layer records one does the command take the unrouted path
                              (ADR-004)
  ${cmd} spawn --repo <name|path> --brief <file> [--task <id> | --new-task] [--title <t>] [--task-title <t>]
            [--slug <s>] [--worker <name>] [--model <m>] [--effort <e>] [--permission-mode <p>]
            [--harness <h>] [--strategy <s>] [--allow-payg] [--refresh] [--dry-run]
                              start a worker — a session in a repository directory
                              connected to the Promptobus bus (run only with approval);
                              --harness must be declared in the workspace tool manifest;
                              --title is the title of this SLICE of work; --task-title is
                              the TASK title; without --task, spawn attaches the worker to
                              the single active task; --new-task opens a separate task;
                              --strategy <quality|balanced|speed|economy|balance> lets
                              the resolver pick harness, model and effort from the rated
                              catalog intersected with what this account can run now
                              (balance spends the subscriptions evenly by the pace of
                              their limit windows rather than by rating)
                              (--allow-payg admits pay-as-you-go tuples, --refresh
                              probes the harnesses instead of reading the cache);
                              --model, --effort and --harness stay CONSTRAINTS on that
                              choice and are never replaced. Without --strategy the
                              recorded workspace default (promptobus models strategy) routes
                              the call; only when no layer records one does the command take
                              the unrouted path (ADR-004)
  ${cmd} models [--strategy <s>] [--role <worker|reviewer|approver>] [--refresh] [--json]
  ${cmd} models validate
  ${cmd} models strategy [--set <s> | --clear]
  ${cmd} models calibrate [--json] [--write] [--yes]
  ${cmd} models --clear-exhausted <harness>
                              what the resolver would pick right now: the chosen tuple,
                              every candidate with its score components, the models the
                              account exposes that the catalog does not rate, and the
                              warnings. Reads the availability cache and asks no harness
                              anything unless --refresh says so — that flag is also the
                              only one that writes a cache entry here.
                              --strategy uses the recorded workspace default, balanced when
                              no layer records one; --role defaults to worker.
                              "validate" checks the catalog and every overlay layer;
                              "calibrate" reads the local telemetry file, groups the runs
                              by harness, model and effort, and PROPOSES speed and
                              quotaCost lines for the user overlay with the medians
                              behind each — nothing below 5 runs on a key, and quality is
                              never proposed from telemetry. --write merges only those
                              ratings into the user layer after you agree (--yes records
                              the agreement where there is no terminal to ask on);
                              --clear-exhausted drops an exhaustion the cache holds with
                              no known reset — nothing else clears one
  ${cmd} status [--task <id>]
                              active tasks: participants, unread mail, session state
  ${cmd} done [--task <id>] [--keep-sessions]
                              close a task (mail stays as a journal); the mailbox owner
                              closes it. Sessions the mechanism started are stopped
                              unless --keep-sessions leaves them running.
                              The last step removes journals of tasks closed more than
                              ${PRUNE_DEFAULT_DAYS} days ago (threshold and dry-run:
                              ${cmd} prune)
  ${cmd} stop <address> [--task <id>]
                              close ONE participant's session and leave the task open —
                              the task mailbox owner stops it. The session record goes
                              with the process; the watch and the mailbox are untouched
                              (that is ${cmd} dismiss). For the whole task — ${cmd} done
  ${cmd} sweep <address> [--task <id>]
                              clean up after ONE accepted piece and leave the task
                              active: the participant's worktree and the branch the
                              mechanism created, the blobs and files-folder links of
                              the artifacts it sent, and its files in workers/. The
                              task mailbox owner or an approver of this task sweeps.
                              A branch whose work is not provably in the default
                              branch keeps its tree, its blobs and its files, and the
                              command says so. Telemetry, canonical messages, the
                              warden log, health and the wait sidecars are never
                              taken: ${cmd} done reads them to write the run's rows.
                              The session must already be closed (${cmd} stop)
  ${cmd} dismiss <address> [--task <id>]
                              stop watching a finished participant — the WATCH only, the
                              process is not touched (that is ${cmd} stop). The task
                              mailbox owner dismisses; reports already sent are not recalled
  ${cmd} history [--task <id>] [--participant <address>] [--limit <n> | --all]
                              journal of READ mail, oldest first;
                              default last 50, --limit changes the count, --all
                              drops the limit; the command does not mark anything read
  ${cmd} prune [--older-than <days>] [--yes]
                              remove journals of long-closed tasks;
                              dry-run by default: prints what would go and deletes nothing;
                              delete only with --yes; age threshold ${PRUNE_DEFAULT_DAYS} days
  ${cmd} guard [--role <address>] [--task <id>] [--home <path>]
                              loop guard: does not let a session end a turn with unread
                              mail. The layout Stop hook calls it; clean — silent exit 0,
                              otherwise return the turn with exit 2
  ${cmd} warden [--task <id>]
                              task warden: its only listener and alarm.
                              On unread mail it wakes the addressee and carries short
                              message text (up to ${KNOCK_TEXT_MAX} characters); mailbox
                              is what marks them read.
                              Any bus command starts it; PROMPTOBUS_WARDEN=off disables auto-start
  ${cmd} lease [--as <address>] [--task <id>] [--wait <seconds>] -- <command…>
                              run a measuring command under the machine lease: one
                              holder per machine, across tasks and workspaces. A live
                              holder is waited out with a line naming it, up to
                              --wait (default ${LEASE_WAIT_SEC} s), then the command is
                              refused unrun; a dead holder is dropped by pid liveness.
                              Exits with the command's own code; status names the holder
  ${cmd} mcp
                              stdio MCP server for the bus
  ${cmd} install [--harnesses claude,cursor,codex] [--check] [--dry-run]
                              install project-level bus hooks; the first call saves
                              the harness list in promptobus.json
  ${cmd} uninstall [--harnesses claude,cursor,codex]
                              remove owned project-level hooks only
`;
}

function parse(name, args, { options = {}, positionals = 0 } = {}) {
  const known = Object.keys(options).map((f) => `--${f}`).join(', ');
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true });
    if (parsed.positionals.length > positionals) {
      const limit = ['takes no arguments', 'takes at most one argument', 'takes at most two arguments'][positionals]
        ?? `takes at most ${positionals} arguments`;
      fail(`${name}: extra argument "${parsed.positionals[positionals]}" — the command ${limit}`);
    }
    return parsed;
  } catch (e) {
    if (!String(e?.code ?? '').startsWith('ERR_PARSE_ARGS_')) throw e;
    fail(`${name}: ${e.message}\n  known flags: ${known || '(this command has no flags)'}`);
  }
}

function writeLine(stream, text) {
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  if (typeof stream.write === 'function') stream.write(chunk);
  else console.log(text);
}

export async function runPromptobus(argv, { host, cwd, env, input, output } = {}) {
  if (!host || typeof host.commandName !== 'string') {
    throw new TypeError('runPromptobus: host is required');
  }
  // Bound once, at the one door every consumer comes through: the registry helpers are
  // called from sites with no host in reach ([harness-home.js](harness-home.js)).
  bindHarnessHomes(host);
  bindHarnessBins(host);
  // Same named exception as the line above, and for the same reason: the core cannot
  // import the driver registry (02-host.md § Session identity, ADR-010).
  bindSessionIdentity(resolveSessionIdentity);
  cwd = cwd ?? process.cwd();
  env = env ?? process.env;
  input = input ?? process.stdin;
  output = output ?? process.stdout;

  const args = [...(argv ?? [])];
  if (args[0] === host.commandName) args.shift();
  const [cmd, ...rest] = args;
  const at = (sub) => `${host.commandName} ${sub}`.trim();

  try {
    if (STORE_COMMANDS.has(cmd)) bus(host.promptobusHome(), { cli: host.version });
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
            strategy: { type: 'string' },
            'allow-payg': { type: 'boolean' },
            refresh: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            approver: { type: 'boolean' },
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
          strategy: values.strategy,
          allowPayg: values['allow-payg'],
          refresh: values.refresh,
          dryRun: values['dry-run'],
          approver: values.approver,
        });
        return 0;
      }
      case 'models': {
        const { values, positionals } = parse(at('models'), rest, {
          options: {
            strategy: { type: 'string' },
            role: { type: 'string' },
            refresh: { type: 'boolean' },
            json: { type: 'boolean' },
            'clear-exhausted': { type: 'string' },
            set: { type: 'string' },
            clear: { type: 'boolean' },
            write: { type: 'boolean' },
            yes: { type: 'boolean' },
          },
          positionals: 1,
        });
        // `return await`, not a bare `return`: the refusal must land in the catch
        // below, which turns a routing code into one line instead of a stack.
        return await (await import('./models.js')).models(host, {
          // The flag defaults live with the command, not here: `models` is not the
          // only caller of the routing gate, and a default spelled twice drifts.
          ...(values.strategy === undefined ? {} : { strategy: values.strategy }),
          ...(values.role === undefined ? {} : { role: values.role }),
          refresh: values.refresh,
          json: values.json,
          clearExhausted: values['clear-exhausted'],
          set: values.set,
          clear: values.clear,
          write: values.write,
          yes: values.yes,
          subcommand: positionals[0],
          output,
        });
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
      // `send` is NOT registered. The command is built (`lib/send.js`) and covered
      // (`test/send.test.mjs`), and it stays unpublished until a fresh review — ADR-011.
      case 'stop': {
        const { values, positionals } = parse(at('stop'), rest, {
          options: { task: { type: 'string' } },
          positionals: 1,
        });
        return (await import('./stop.js')).stop(host, {
          address: positionals[0],
          task: values.task,
        });
      }
      case 'sweep': {
        const { values, positionals } = parse(at('sweep'), rest, {
          options: { task: { type: 'string' } },
          positionals: 1,
        });
        return (await import('./sweep.js')).sweep(host, {
          address: positionals[0],
          task: values.task,
        });
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
            strategy: { type: 'string' },
            'allow-payg': { type: 'boolean' },
            refresh: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
          },
        });
        await (await import('./spawn.js')).spawn(host, {
          ...values,
          dryRun: values['dry-run'],
          newTask: values['new-task'],
          permissionMode: values['permission-mode'],
          taskTitle: values['task-title'],
          allowPayg: values['allow-payg'],
        });
        return 0;
      }
      case 'lease': {
        const { values, positionals } = parse(at('lease'), rest, {
          options: { as: { type: 'string' }, task: { type: 'string' }, wait: { type: 'string' } },
          positionals: Infinity,
        });
        return await (await import('./lease.js')).lease(host, { ...values, command: positionals, env, cwd });
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
      case 'install': {
        const { values } = parse(at('install'), rest, {
          options: {
            harnesses: { type: 'string' },
            check: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
          },
        });
        const { install } = await import('./install.js');
        return install(host, {
          harnesses: values.harnesses,
          check: values.check,
          dryRun: values['dry-run'],
          cwd,
          env,
        });
      }
      case 'uninstall': {
        const { values } = parse(at('uninstall'), rest, {
          options: { harnesses: { type: 'string' } },
        });
        const { uninstall } = await import('./install.js');
        return uninstall(host, {
          harnesses: values.harnesses,
          cwd,
          env,
        });
      }
      default:
        fail(`${host.commandName}: unknown command "${cmd ?? ''}" — ${SUBCOMMANDS}`);
    }
  } catch (e) {
    const expected = e?.status !== undefined
      || e instanceof GateError
      // A routing refusal is a `PromptobusError`: its message is the whole diagnosis, and
      // a stack under it would bury the part a person reads.
      || e instanceof PromptobusError
      || e instanceof HostResolveError;
    if (!expected && e?.stack) console.error(e.stack);
    fail(e.message ?? String(e));
  }
  return 0;
}
