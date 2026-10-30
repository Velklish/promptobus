// Package command entry point. The host is passed in — no process-wide singleton, two hosts
// in one process are legal; the one exception is [`harnessStateHome`](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says).

import { parseArgs } from 'node:util';
import { openEngine, GateError, PromptobusError, registryOf, routedCatalogRoles } from '../dist/index.js';
import { HostResolveError } from '../dist/host.js';
import { fail } from './util.js';
import {
  KNOCK_TEXT_MAX, PRUNE_DEFAULT_DAYS, TEAMLEAD_HARNESSES, harnessName,
} from './contract.js';
import { LEASE_WAIT_SEC } from './lease.js';
import { bindHarnessBins, bindHarnessHomes } from './harness-home.js';
import { resolveSessionIdentity } from './drivers.js';
import { bindSessionIdentity, bus } from './store.js';
import { CONTEXT_FLAGS, contextCliOptions } from './native-participant-context.js';

import type { ParseArgsConfig } from 'node:util';
type ParseArgsOptionsConfig = NonNullable<ParseArgsConfig['options']>;
import type { PromptobusHost } from '../dist/index.js';
import type { GuardInput } from './guard.js';
import type { ServiceHostFactory } from './service.js';

interface CommandOutput { write?(chunk: string): unknown }
type CliHost = Pick<PromptobusHost, 'kind' | 'commandName' | 'version'>;
interface RunOptions { host?: CliHost | null; cwd?: string; env?: NodeJS.ProcessEnv; input?: GuardInput; output?: CommandOutput; createHost?: ServiceHostFactory }

// The command vocabulary, exported so a host's passthrough and refusal read it rather than a copy.
export const COMMANDS = Object.freeze([
  'lead', 'spawn', 'step', 'review', 'report', 'models', 'status', 'digest', 'send', 'ask', 'link', 'unlink',
  'message-order', 'done', 'abandon', 'stop', 'sweep', 'dismiss', 'history', 'guard', 'warden', 'service', 'mcp', 'install', 'uninstall', 'lease', 'stats',
]);
// `send` and `ask` are not store commands on purpose: each resolves its own home and primes the store
// after the resolve, so priming the host's here would open a second one for nothing.
const STORE_COMMANDS = new Set(['spawn', 'step', 'review', 'report', 'status', 'digest', 'done', 'abandon', 'stop', 'sweep', 'dismiss', 'history']);

export function helpText(host: Pick<PromptobusHost, 'commandName'>) {
  const cmd = host.commandName;
  return `Promptobus — a bus for agent sessions

Usage: ${cmd} <command>
Help: ${cmd} help (same as no command, --help, -h) · version: ${cmd} --version (-v)

Participant launch options: --context-purpose technical|user-facing|author-voice
                            --context-file <JSON declaration of skills/resources>

  ${cmd} lead --brief <file> [--task <new-id>] [--title <t>]
            [--harness codex] [--model <m>] [--effort <e>]
            --permission-mode full-access [--strategy <s>] [--dry-run]
                              start a managed Codex root orchestrator with its own
                              mailbox and wake holder; opens a new root task and
                              writes no project layer into the shared install root.
  ${cmd} lead --resume --task <existing-id> [--model <m>] [--effort <e>]
                              resume an active managed Codex root after its holder stops;
                              keeps its native thread and journal, refreshes private auth,
                              and refuses an active holder or a different owner.

  ${cmd} step <name> <path> --task <id> [--base <ref>] [--brief <file>]
            [--model <m>] [--effort <e>] [--permission-mode <p>] [--harness <h>]
            [--strategy <s>] [--allow-payg] [--refresh] [--dry-run]
                              lift a named gate of the declared pipeline. A later gate
                              requires a result from its preceding step for this subject;
                              a writes-main-tree gate also requires the owner's result.
                              --brief is available for a writes-main-tree gate.
  ${cmd} review <path> [--task <id> | --title <name>] [--base <ref>] [--model <m>] [--effort <e>]
            [--permission-mode <p>] [--harness <h>] [--strategy <s>] [--allow-payg] [--refresh] [--dry-run]
            [--approver] [--brief <file>]
                              isolated review of repository changes: the reviewer is a
                              background Promptobus session, read-only; the subject is the
                              diff; the path is required — there is no resolve from the
                              current directory; without --task the directory picks the
                              task: if it is listed as a participant worktree of an active
                              task, that task is used; if it is listed nowhere, a new
                              review task is opened; --task <id> overrides both, and a
                              repeat call sends the reviewer a new diff;
                              review selects the first reads-diff gate; --approver with
                              --task selects the first writes-main-tree gate after its
                              required results. It does not judge the review; acceptance runs in
                              its own worktree and reaches the clone by fast-forward;
                              --brief <file> with --approver is that approver's assignment,
                              handed over in the lift and kept in the task files after it;
                              without --approver it is refused, because a reviewer's
                              subject is the diff;
                              --strategy lets the resolver pick the reviewer tuple —
                              --model, --effort and --harness stay constraints on it;
                              without --strategy the recorded workspace default
                              (promptobus models strategy) routes the call; only when no
                              layer records one does the command take the unrouted path
                              (ADR-005)
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
                              the unrouted path (ADR-005)
  ${cmd} spawn --teamlead --brief <file> --task <root> [--slug <s>]
            [--strategy <s>] [--harness ${TEAMLEAD_HARNESSES.join('|')}] [--model <m>] [--effort <e>]
            [--permission-mode <p>] [--allow-payg] [--refresh] [--dry-run]
                              lifts a child-task orchestrator at the install root on
                              ${TEAMLEAD_HARNESSES.map(harnessName).join(' or ')}; Cursor is refused before start.
                              A Codex teamlead also takes --permission-mode full-access
  ${cmd} report --task <root> [--strategy <s>] [--harness claude|codex] [--model <m>] [--effort <e>]
            [--permission-mode <p>] [--allow-payg] [--refresh] [--dry-run]
                              lift one read-only Claude Code or Codex reporter for the root task;
  ${cmd} report --task <root> --question <text>
                              ask the existing Codex reporter and print its reply;
                              it answers from the digest and journals, asking the root
                              orchestrator as user when those records do not answer
  ${cmd} models [--strategy <s>] [--role <${routedCatalogRoles(registryOf(host as PromptobusHost)).join('|')}|step-name>] [--refresh | --no-probe] [--json]
  ${cmd} models validate
  ${cmd} models strategy [--set <s> | --clear]
  ${cmd} models calibrate [--json] [--write] [--yes]
  ${cmd} models --clear-exhausted <harness>
                              what the resolver would pick right now: the chosen tuple,
                              every candidate with its score components, the models the
                              account exposes that the catalog does not rate, and the
                              warnings. Probes by default and updates the cache;
                              --no-probe reads only the last cached readings.
                              Without --strategy, models uses the recorded default, balanced when
                              no layer records one; --role defaults to worker.
                              "validate" checks the catalog and every overlay layer;
                              "calibrate" reads the local telemetry file, groups the runs
                              by harness, model and effort, and PROPOSES speed and
                              quotaCost lines for the user overlay with the medians
                              behind each — quotaCost needs 5 runs per key; speed needs
                              5 usable throughput observations per harness/model across
                              effort levels. Quality is never proposed from telemetry.
                              --write merges only those
                              ratings into the user layer after you agree (--yes records
                              the agreement where there is no terminal to ask on);
                              --clear-exhausted drops an exhaustion the cache holds with
                              no known reset — nothing else clears one
  ${cmd} status [--task <id>]
                              active tasks: participants, unread mail, session state
  ${cmd} digest [--task <id>] [--json]
                              task trees: last status lines, open questions, debts and pieces
  ${cmd} stats [--task <id>]
                              recorded participant generations: wall time, token kinds,
                              bus counts and reasons for unavailable measurements
  ${cmd} send <address> (--body <text> | --file <path>) [--type <type>] [--task <id>] [--artifact <file>]
                              write one bus message as the address this session holds
                              in the task: the participant whose recorded session is this
                              one. A declared PROMPTOBUS_ROLE must agree with that record;
                              a record bound to no session is never sent as, and a task
                              with no owner has no provable orchestrator. There is no
                              --from: a sender that can be chosen is a sender that can be
                              borrowed. Type defaults to status
  ${cmd} link <task-a> <task-b>
                              link two active root tasks as peers; the owner of either
                              task must call. Each peer address holds the other owner's session
  ${cmd} unlink <task-a> <task-b>
                              remove both peer records; existing journal mail remains
  ${cmd} ask "<text>" --task <id> [--to orchestrator | teamlead:<slug>]
  ${cmd} ask --answers --task <id>
                              ask as user from a plain terminal, or read the user mailbox
                              and mark it read. A teamlead target selects its child task;
                              read those answers with that child's task id
  ${cmd} message-order rebuild
                              explicitly reconstruct the store-local ordering high-water
                              from complete retained messages, intents and assignment fences.
                              Stop older writers first; unreadable retained state refuses.
  ${cmd} done [--task <id>] [--keep-sessions] [--older-than <days>] [--yes]
                              close a task (mail stays as a journal); the mailbox owner
                              closes it. Native work needs confirmed Stop first, or
                              ${cmd} abandon when that harness already reports the
                              session dead. Other sessions stop unless --keep-sessions
                              is explicit. The last step removes journals of tasks
                              closed more than ${PRUNE_DEFAULT_DAYS} days ago.
                              --older-than <days> previews that removal at the given
                              age and deletes nothing; --yes applies the preview
  ${cmd} abandon [<address>] [--task <id>]
                              retire a participant whose own harness reports the
                              session dead and who has no Stop receipt. The mailbox
                              owner calls it from whichever harness names this
                              session; the participant may be on any harness. The
                              journal names the missing receipt and does not gain a
                              Stop receipt. A live session is refused. With no
                              address, every such participant of the task is retired.
                              Then ${cmd} done.
  ${cmd} stop <address> [--task <id>]
                              close ONE participant's session and leave the task open —
                              the task mailbox owner or an approver of this task stops
                              it. The session record goes with the process; the watch
                              and the mailbox are untouched (that is ${cmd} dismiss).
                              For the whole task — ${cmd} done
  ${cmd} sweep <address> [--task <id>]
                              clean up after ONE accepted piece and leave the task
                              active: the participant's worktree and the branch the
                              mechanism created, and its files in workers/. Artifact
                              records, files/ entries and blobs stay with the task
                              journal. The task mailbox owner or an approver of this
                              task sweeps. A branch whose work is not provably in
                              the default branch keeps its tree, and the command
                              says so. Telemetry, canonical messages, the warden
                              log, health and the wait sidecars are never taken:
                              ${cmd} done reads them to write the run's rows.
                              The session must already be closed (${cmd} stop)
  ${cmd} dismiss <address> [--task <id>]
                              stop watching a finished participant — the WATCH only, the
                              process is not touched (that is ${cmd} stop). The task
                              mailbox owner or an approver of this task dismisses;
                              reports already sent are not recalled
  ${cmd} history [--task <id>] [--participant <address>] [--limit <n> | --all]
                              journal of READ mail, oldest first;
                              default last 50, --limit changes the count, --all
                              drops the limit; the command does not mark anything read
  ${cmd} guard [--role <address>] [--task <id>] [--home <path>]
                              loop guard: does not let a session end a turn with unread
                              mail. The layout Stop hook calls it; clean — silent exit 0,
                              otherwise return the turn with exit 2
  ${cmd} warden [--task <id>]
                              task warden: its only listener and alarm.
                              On unread mail it wakes the addressee with one stub per
                              message and never its text (a block of at most
                              ${KNOCK_TEXT_MAX} characters); mailbox is what marks them read.
                              Any bus command starts it; PROMPTOBUS_WARDEN=off disables auto-start
  ${cmd} lease [--as <address>] [--task <id>] [--key <clone-root>] [--wait <seconds>] -- <command…>
                              run under the machine lease, or with --key under a
                              clone publication lease. A live
                              holder is waited out with a line naming it, up to
                              --wait (default ${LEASE_WAIT_SEC} s), then the command is
                              refused unrun; a dead holder is dropped by pid liveness.
                              Exits with the command's own code; status names the holder
  ${cmd} service ensure|status|stop [--json]
                              ensure, inspect or stop the shared workspace service;
                              stop refuses live clients or active work
  ${cmd} service run
                              internal shared service entry; the consumer supplies
                              its Host factory through runPromptobus options
  ${cmd} mcp
                              stdio MCP server for the bus
  ${cmd} install [--harnesses claude,cursor,codex] [--check] [--dry-run]
                              install project-level bus hooks; the first call saves
                              the harness list in promptobus.json
  ${cmd} uninstall [--harnesses claude,cursor,codex]
                              remove owned project-level hooks only
`;
}

function parse<const O extends ParseArgsOptionsConfig = {}>(name: string, args: string[], { options = {} as O, positionals = 0 }: { options?: O; positionals?: number } = {}) {
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
    if (!String((e as NodeJS.ErrnoException | null | undefined)?.code ?? '').startsWith('ERR_PARSE_ARGS_')) throw e;
    fail(`${name}: ${(e as Error).message}\n  known flags: ${known || '(this command has no flags)'}`);
  }
}

function writeLine(stream: CommandOutput, text: string) {
  const chunk = text.endsWith('\n') ? text : `${text}\n`;
  if (typeof stream.write === 'function') stream.write(chunk);
  else console.log(text);
}

export async function runPromptobus(argv: readonly string[] | null | undefined, { host: suppliedHost, cwd, env, input, output, createHost }: RunOptions = {}) {
  const host = suppliedHost as PromptobusHost | null | undefined;
  if (!host || typeof host.commandName !== 'string') {
    throw new TypeError('runPromptobus: host is required');
  }
  // Bound once, at the one door every consumer comes through: the registry helpers are
  // called from sites with no host in reach ([harness-home.js](harness-home.js)).
  bindHarnessHomes(host);
  bindHarnessBins(host);
  // Same named exception as the line above, and for the same reason: the core cannot
  // import the driver registry (02-host.md § Session identity, ADR-019).
  bindSessionIdentity(resolveSessionIdentity);
  cwd = cwd ?? process.cwd();
  env = env ?? process.env;
  input = input ?? process.stdin;
  output = output ?? process.stdout;

  const args = [...(argv ?? [])];
  if (args[0] === host.commandName) args.shift();
  const [cmd, ...rest] = args;
  const at = (sub: string) => `${host.commandName} ${sub}`.trim();

  try {
    if (STORE_COMMANDS.has(cmd as string)) bus(host.promptobusHome(), { cli: host.version });
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
        await (await import('./server.js')).serve({ host, env, cwd, input, output: output as { write(chunk: string): unknown } });
        return 0;
      }
      case 'service': {
        const [operation, ...flags] = rest;
        if (!['ensure', 'run', 'status', 'stop'].includes(operation ?? '')) throw new GateError('service requires ensure, run, status or stop');
        const { values } = parse(at(`service ${operation}`), flags, { options: { json: { type: 'boolean' } } });
        if (operation === 'run') {
          if (!createHost) throw new GateError('Shared service requires the consumer-owned createHost({cwd, env}) option');
          await (await import('./service.js')).runWorkspaceService({ host, createHost, env });
          return 0;
        }
        const client = await import('./service-client.js');
        const result = operation === 'ensure' ? await client.ensureWorkspaceService(host, { cwd, env })
          : operation === 'status' ? await client.workspaceServiceStatus(host, { env }) : await client.stopWorkspaceService(host, { env });
        writeLine(output, values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
        return 0;
      }
      case 'lead': {
        const { values } = parse(at('lead'), rest, { options: {
          ...CONTEXT_FLAGS,
          brief: { type: 'string' }, task: { type: 'string' }, title: { type: 'string' },
          resume: { type: 'boolean' },
          harness: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
          'permission-mode': { type: 'string' }, strategy: { type: 'string' },
          'allow-payg': { type: 'boolean' }, refresh: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
        } });
        await (await import('./lead.js')).lead(host, {
          ...contextCliOptions(values, cwd),
          ...values, permissionMode: values['permission-mode'], allowPayg: values['allow-payg'],
          dryRun: values['dry-run'],
        });
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
            ...CONTEXT_FLAGS,
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
            brief: { type: 'string' },
          },
          positionals: 1,
        });
        await (await import('./review.js')).review(host, {
          ...contextCliOptions(values, cwd),
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
          brief: values.brief,
        });
        return 0;
      }
      case 'step': {
        const { values, positionals } = parse(at('step'), rest, {
          options: {
            ...CONTEXT_FLAGS,
            base: { type: 'string' },
            task: { type: 'string' },
            brief: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            'permission-mode': { type: 'string' },
            harness: { type: 'string' },
            strategy: { type: 'string' },
            'allow-payg': { type: 'boolean' },
            refresh: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
          },
          positionals: 2,
        });
        await (await import('./review.js')).step(host, {
          ...contextCliOptions(values, cwd),
          stepName: positionals[0], target: positionals[1],
          base: values.base, task: values.task, brief: values.brief,
          model: values.model, effort: values.effort, permissionMode: values['permission-mode'],
          harness: values.harness, strategy: values.strategy, allowPayg: values['allow-payg'],
          refresh: values.refresh, dryRun: values['dry-run'],
        });
        return 0;
      }
      case 'models': {
        const { values, positionals } = parse(at('models'), rest, {
          options: {
            strategy: { type: 'string' },
            role: { type: 'string' },
            refresh: { type: 'boolean' },
            'no-probe': { type: 'boolean' },
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
          noProbe: values['no-probe'],
          json: values.json,
          clearExhausted: values['clear-exhausted'],
          set: values.set,
          clear: values.clear,
          write: values.write,
          yes: values.yes,
          subcommand: positionals[0],
          output: output as { write(text: string): unknown },
        });
      }
      case 'stats': {
        const { values } = parse(at('stats'), rest, { options: { task: { type: 'string' } } });
        const { telemetryStats } = await import('../dist/telemetry.js');
        const { taskHash } = await import('./model-routing/telemetry.js');
        const stats = telemetryStats(host, { task: values.task });
        if (stats?.unreadable) throw new GateError('telemetry file is unreadable');
        const names = new Map();
        if (values.task) {
          const { readTask, addressOf } = await import('./store.js');
          try {
            for (const p of readTask(host.promptobusHome(), values.task).participants) names.set(taskHash(p.id), addressOf(p));
          } catch {
            // Journals may have been pruned; opaque participant keys remain readable.
          }
        }
        writeLine(output, 'task\tparticipant\tgeneration\trole\tharness\tmodel\twall-seconds\tinput\tcache-read\tcache-write\toutput\tmessages\treviews\tquestions\tresults\treason');
        for (const row of stats?.participants ?? []) {
          const cells = [row.task, names.get(row.participant) ?? row.participant, row.generation,
            row.role, row.harness, row.model, row.durationSec,
            row.tokens?.input, row.tokens?.cacheRead, row.tokens?.cacheWrite, row.tokens?.output,
            row.turns, row.reviewRounds, row.questions, row.resultCount,
            row.tokens ? row.tokens.reason : 'legacy_record_without_token_usage'];
          writeLine(output, cells.map((cell) => cell === null || cell === undefined ? '?' : String(cell).replace(/[\t\r\n]/g, ' ')).join('\t'));
        }
        return 0;
      }
      case 'send': {
        const { values, positionals } = parse(at('send'), rest, {
          options: {
            task: { type: 'string' },
            type: { type: 'string' },
            body: { type: 'string' },
            file: { type: 'string' },
            artifact: { type: 'string' },
          },
          positionals: 1,
        });
        return (await import('./send.js')).send(host, { ...values, to: positionals[0] }, { cwd, env });
      }
      case 'link':
      case 'unlink': {
        const { positionals } = parse(at(cmd), rest, { positionals: 2 });
        return (await import('./link.js')).link(host, positionals[0], positionals[1], {
          unlink: cmd === 'unlink', cwd, env,
        });
      }
      case 'ask': {
        const { values, positionals } = parse(at('ask'), rest, {
          options: { task: { type: 'string' }, to: { type: 'string' }, answers: { type: 'boolean' } },
          positionals: 1,
        });
        return (await import('./send.js')).ask(host, {
          task: values.task, to: values.to, answers: values.answers, body: positionals[0],
        }, { cwd, env });
      }
      case 'report': {
        const { values } = parse(at('report'), rest, {
          options: {
            ...CONTEXT_FLAGS,
            task: { type: 'string' }, question: { type: 'string' }, strategy: { type: 'string' },
            harness: { type: 'string' }, model: { type: 'string' },
            effort: { type: 'string' }, 'permission-mode': { type: 'string' },
            'allow-payg': { type: 'boolean' }, refresh: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
          },
        });
        if (values.question !== undefined) {
          const incompatible = Object.keys(values).filter((key) => !['task', 'question'].includes(key));
          if (incompatible.length) throw new GateError(`report --question cannot use launch options: ${incompatible.map((key) => `--${key}`).join(', ')}`);
          await (await import('./report.js')).reportQuestion(host, { task: values.task, question: values.question }, { cwd, env });
          return 0;
        }
        await (await import('./report.js')).report(host, {
          ...contextCliOptions(values, cwd),
          ...values, permissionMode: values['permission-mode'],
          allowPayg: values['allow-payg'], dryRun: values['dry-run'],
        });
        return 0;
      }
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
      case 'message-order': {
        if (rest[0] !== 'rebuild') throw new GateError(`${at('message-order')} requires rebuild`);
        parse(at('message-order rebuild'), rest.slice(1));
        const engine = openEngine({ home: host.promptobusHome(), recover: false, policy: () => ({ deny: true, reason: 'ordering maintenance only' }) });
        writeLine(output, JSON.stringify(engine.rebuildMessageOrder()));
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
            ...CONTEXT_FLAGS,
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
            teamlead: { type: 'boolean' },
          },
        });
        await (await import('./spawn.js')).spawn(host, {
          ...contextCliOptions(values, cwd),
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
          options: { as: { type: 'string' }, task: { type: 'string' }, key: { type: 'string' }, wait: { type: 'string' } },
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
      case 'digest': {
        const { values } = parse(at('digest'), rest, {
          options: { task: { type: 'string' }, json: { type: 'boolean' } },
        });
        (await import('./digest.js')).digest(host, values);
        return 0;
      }
      case 'abandon': {
        const { values, positionals } = parse(at('abandon'), rest, {
          options: { task: { type: 'string' } },
          positionals: 1,
        });
        return (await import('./abandon.js')).abandon(host, {
          address: positionals[0],
          task: values.task,
        });
      }
      case 'done': {
        const { values } = parse(at('done'), rest, {
          options: {
            task: { type: 'string' },
            'keep-sessions': { type: 'boolean' },
            'older-than': { type: 'string' },
            yes: { type: 'boolean' },
          },
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
        fail(`${host.commandName}: unknown command "${cmd ?? ''}" — ${COMMANDS.join(', ')}`);
    }
  } catch (e) {
    const expected = (e as { status?: unknown } | null | undefined)?.status !== undefined
      || e instanceof GateError
      // A routing refusal is a `PromptobusError`: its message is the whole diagnosis, and
      // a stack under it would bury the part a person reads.
      || e instanceof PromptobusError
      || e instanceof HostResolveError;
    if (!expected && (e as Error | null | undefined)?.stack) console.error((e as Error).stack);
    fail((e as Error).message ?? String(e));
  }
  return 0;
}
