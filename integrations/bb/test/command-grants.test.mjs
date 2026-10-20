import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderBbInstructionSkill } from 'promptobus/instructions';
import { renderBbInstructionSkill as renderCanonical } from '../../../lib/instructions.js';

const roles = ['orchestrator', 'approver', 'worker'];
const surfaces = [
  ['canonical', Object.fromEntries(roles.map(role => [role, renderCanonical(role)]))],
  ['installed', Object.fromEntries(roles.map(role => [role, renderBbInstructionSkill(role)]))],
  ['shipped', Object.fromEntries(roles.map(role => [role,
    readFileSync(new URL(`../skills/promptobus-${role}/SKILL.md`, import.meta.url), 'utf8')]))],
];

// This fixture models instruction compliance under controlled delivery, not BB execution.
// Only directives in the owning rendered/shipped contract enable the corresponding guard.
function controlledDelivery(context, text, role = 'approver') {
  const owner = text.orchestrator;
  const participant = text[role];
  const complete = body => /same canonical task[^.]*owner confirmation|owner confirmation[^.]*same canonical task/i.test(body)
    && /authenticated actor/i.test(body) && /exact command scope/i.test(body) && /authorization (?:identity|token)/i.test(body)
    && !/(?:^|[.!?]\s+|\n)\s*(?:Require|Wait for) a separate (?:owner )?confirmation|do not execute until[^.]*separate canonical task[^.]*owner confirms/i.test(body);
  const policy = {
    complete: complete(owner) && complete(participant),
    prebound: /(?:persist|prebind)[^.]*before[^.]*(?:dispatch|deliver)/i.test(owner),
    terminal: [owner, participant].every(body => /released[^.]*terminal|terminal[^.]*release/i.test(body)
      && /(?:confirmation|resume)[^.]*must not revive/i.test(body)),
    retain: /(?:retain|keep)[^.]*slot[^.]*until[^.]*acknowledg/i.test(owner),
    exactRelease: /release[^.]*actor[^.]*token[^.]*scope[^.]*pending[^.]*running[^.]*(?:zero|0)/i.test(owner),
    guard: /immediately before every mechanical call[^.]*control[^.]*STOP[^.]*actor[^.]*token/i.test(participant),
    runner: /runner-only release[^.]*does not authorize[^.]*closure lint/i.test(participant),
    stop: /official[^.]*(?:stop|pause)[^.]*verif/i.test(owner),
    routing: /fresh[^.]*account routing[^.]*before[^.]*suite/i.test(participant),
    update: /changed precondition[^.]*acknowledged application/i.test(owner),
  };
  const journal = [];
  context.after(() => context.diagnostic(JSON.stringify({ kind:'controlled-delivery', journal })));
  const grants = new Map();
  const queue = [];
  const preserved = { source:'unchanged', worktrees:['/owned/a','/owned/b'], receipts:['raw UTF-8 evidence'],
    unrelated:{ actor:'w-unrelated', token:'unrelated-01', state:'active' } };
  let slot = null;
  let stop = false;
  let active = true;
  let routing = 0;
  let requiredRouting = false;
  const record = (event, data = {}) => {
    const row = { ...data, seq:journal.length + 1, event }; journal.push(row); return row;
  };
  const valid = grant => grant && typeof grant.actor === 'string' && grant.actor.length > 0
    && typeof grant.token === 'string' && grant.token.length > 0 && Array.isArray(grant.scope) && grant.scope.length > 0
    && grant.scope.every(command => typeof command === 'string' && command.length > 0)
    && typeof grant.preconditions?.routingBeforeSuite === 'boolean';
  const matches = (left, right) => valid(right) && left.actor === right.actor && left.token === right.token
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.preconditions) === JSON.stringify(right.preconditions);
  const current = (grant, state) => active && grant.state === state && slot?.state === state
    && matches(grant.authorization, grant) && matches(grant.authorization, slot);
  const exactReceipt = (grant, evidence) => evidence?.actor === grant.actor && evidence.token === grant.token
    && JSON.stringify(evidence.scope) === JSON.stringify(grant.scope) && evidence.pending === 0 && evidence.running === 0;
  const bind = grant => {
    if (!valid(grant) || grants.has(grant.token)) return false;
    const state = { ...structuredClone(grant), authorization:structuredClone(grant),
      state:'granted', confirmed:false, pending:0, running:0, acknowledged:false, stopped:false };
    grants.set(grant.token, state); slot = state; record('prebind', { actor:grant.actor, token:grant.token }); return state;
  };
  const deliver = message => {
    record('deliver', { type:message.type, token:message.token });
    const grant = grants.get(message.token);
    if (!grant || (policy.terminal && grant.state === 'released')) return false;
    if (message.type === 'task') {
      grant.confirmed = policy.complete && policy.prebound && message.ownerConfirmation === true
        && matches(grant.authorization, message) && current(grant, 'granted');
      if (grant.confirmed) requiredRouting = grant.authorization.preconditions.routingBeforeSuite;
    } else if (message.type === 'confirmation' || message.type === 'resume') {
      if (grant.state === 'released' && policy.terminal) return false;
      grant.confirmed = true; grant.state = 'granted';
    } else if (message.type === 'Hold') grant.confirmed = false;
    return grant.confirmed;
  };
  const call = (grant, command) => {
    record('check', { actor:grant.actor, token:grant.token, command, active, stop, slot:slot?.token, routing });
    if (!grant.confirmed || (policy.terminal && grant.state !== 'granted')) return false;
    if (policy.guard && (stop || !current(grant, 'granted'))) return false;
    if (policy.runner && !grant.scope.includes(command)) return false;
    if (policy.routing && requiredRouting && routing === 0) return false;
    grant.running += 1; record('call-start', { actor:grant.actor, token:grant.token, command });
    routing = 0;
    grant.running -= 1; record('call-end', { actor:grant.actor, token:grant.token, command, exit:0 });
    return true;
  };
  const release = (grant, receipt = {}) => {
    record('release', { actor:grant.actor, token:grant.token, scope:grant.scope, pending:grant.pending, running:grant.running });
    if (policy.exactRelease && (!exactReceipt(grant, receipt) || !current(grant, 'granted') || grant.pending || grant.running)) return false;
    grant.releaseReceipt = structuredClone(receipt);
    grant.state = 'released'; return true;
  };
  return {
    journal, preserved, bind, deliver, call, release,
    enqueue(message) { queue.push(message); record('enqueue', { type:message.type, token:message.token }); },
    deliverNext() { return deliver(queue.shift()); },
    acknowledge(grant, evidence = grant.releaseReceipt) {
      if (!current(grant, 'released') || !exactReceipt(grant, evidence) || grant.pending || grant.running || grant.acknowledged) return false;
      grant.acknowledged = true; record('release-ack', { actor:grant.actor, token:grant.token, scope:grant.scope }); return true;
    },
    transfer(grant) {
      if (policy.retain && slot && !slot.acknowledged && !slot.stopped) return false;
      if (!bind(grant)) return false;
      record('transfer', { actor:grant.actor, token:grant.token }); return true;
    },
    officialStop(grant, observation) {
      const request = record('stop-request', { actor:grant.actor, token:grant.token });
      const observed = record('stop-observation', observation);
      if (!current(grant, 'granted') || observation.actor !== grant.actor || observation.token !== grant.token
        || JSON.stringify(observation.scope) !== JSON.stringify(grant.scope) || observation.requestSeq !== request.seq
        || observation.observedSeq !== observed.seq || observation.pending !== 0 || observation.running !== 0
        || grant.pending !== 0 || grant.running !== 0) return false;
      if (!policy.stop || !observation.confirmed || !observation.deliveryPaused || observation.status !== 'idle'
        || observation.background !== 0 || observation.queue !== 0) return false;
      grant.stopped = true; grant.state = 'released'; record('stop-ack', { actor:grant.actor, token:grant.token }); return true;
    },
    setSTOP(value) { stop = value; },
    setActive(value) { active = value; },
    changeSlot(value) { slot = value; },
    freshRouting() { routing += 1; record('routing'); },
    updatePrecondition(acknowledged) { record('precondition-update', { acknowledged }); if (!policy.update || acknowledged) requiredRouting = true; },
  };
}

const assignment = (actor = 'a-command', token = 'command-01', scope = ['runner']) => ({ actor, token, scope,
  preconditions:{ routingBeforeSuite:false } });
const task = grant => ({ type:'task', actor:grant.actor, token:grant.token, scope:grant.scope,
  preconditions:grant.preconditions, ownerConfirmation:true });
const receipt = grant => ({ actor:grant.actor, token:grant.token, scope:grant.scope, pending:0, running:0 });

for (const [surface, text] of surfaces) {
  for (const role of ['approver', 'worker']) {
    test(`${surface} ${role}: complete grant rejects missing identity scope and bound precondition mismatch`, context => {
      for (const field of ['actor','token','scope','preconditions']) {
        const fixture = controlledDelivery(context, text, role);
        for (const value of [undefined, null, ...(field === 'scope' ? [[]] : field === 'preconditions' ? [{}] : [''])]) {
          const invalid = { ...assignment(), [field]:value };
          assert.equal(fixture.bind(invalid), false, `missing ${field} must not be prebound`);
          assert.equal(fixture.deliver({ ...task(invalid) }), false);
          assert.equal(fixture.journal.filter(row => row.event === 'call-start').length, 0);
        }
      }
      for (const change of [{ token:undefined }, { token:'foreign-02' }, { preconditions:undefined },
        { preconditions:{} }, { preconditions:{ routingBeforeSuite:false } }]) {
        const fixture = controlledDelivery(context, text, role);
        const bound = { ...assignment(), preconditions:{ routingBeforeSuite:true } };
        const grant = fixture.bind(bound);
        assert.equal(fixture.deliver({ ...task(grant), ...change }), false);
        assert.equal(fixture.call(grant, 'runner'), false);
        assert.equal(fixture.deliver(task(grant)), true);
        assert.equal(fixture.call(grant, 'runner'), false);
        fixture.freshRouting();
        assert.equal(fixture.call(grant, 'runner'), true);
      }
      const fixture = controlledDelivery(context, text, role);
      const original = assignment();
      const grant = fixture.bind(original);
      original.scope.push('closure lint'); original.preconditions.routingBeforeSuite = true;
      assert.deepEqual(grant.scope, ['runner']);
      assert.deepEqual(grant.preconditions, { routingBeforeSuite:false });
      assert.equal(fixture.deliver(task(grant)), true);
      assert.equal(fixture.call(grant, 'runner'), true);
    });

    test(`${surface} ${role}: current scope and binding guard calls release and acknowledgment`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment()); fixture.deliver(task(grant));
      for (const change of [{ scope:['closure lint'] }, { actor:'a-foreign' }, { token:'foreign-02' },
        { state:'released' }, { preconditions:{ routingBeforeSuite:true } }]) {
        fixture.changeSlot({ ...grant, ...change });
        assert.equal(fixture.call(grant, 'runner'), false);
        assert.equal(fixture.release(grant, receipt(grant)), false);
        assert.equal(grant.state, 'granted');
      }
      fixture.changeSlot(grant);
      assert.equal(fixture.call(grant, 'runner'), true);
      assert.equal(fixture.release(grant, receipt(grant)), true);
      for (const change of [{ scope:['closure lint'] }, { actor:'a-foreign' }, { token:'foreign-02' }, { state:'granted' }]) {
        fixture.changeSlot({ ...grant, ...change });
        assert.equal(fixture.acknowledge(grant, receipt(grant)), false);
        assert.equal(fixture.transfer(assignment('a-next','next-02')), false);
      }
      fixture.changeSlot(grant);
      for (const change of [{ actor:'a-foreign' }, { token:'foreign-02' }, { scope:['closure lint'] },
        { pending:1 }, { running:1 }]) {
        assert.equal(fixture.acknowledge(grant, { ...receipt(grant), ...change }), false);
      }
      assert.equal(fixture.acknowledge(grant, receipt(grant)), true);
      assert.equal(fixture.transfer(assignment('a-next','next-02')), true);
      assert.equal(fixture.acknowledge(grant, receipt(grant)), false);
      assert.equal(fixture.call(grant, 'runner'), false);
      assert.equal(fixture.journal.filter(row => row.event === 'release-ack').length, 1);
    });

    test(`${surface} ${role}: prebound complete task starts preparation on immediate delivery`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment('w-command', 'prepare-02', ['preparation']));
      assert.equal(fixture.deliver(task(grant)), true);
      assert.equal(fixture.call(grant, 'preparation'), true);
      assert.deepEqual(fixture.journal.map(row => row.event), ['prebind','deliver','check','call-start','call-end']);
      const missing = fixture.bind(assignment('w-command', 'prepare-03', ['preparation']));
      assert.equal(fixture.deliver({ ...task(missing), ownerConfirmation:false }), false);
      assert.equal(fixture.call(missing, 'preparation'), false);
      for (const change of [{ actor:'w-other' }, { scope:['closure lint'] }]) {
        assert.equal(fixture.deliver({ ...task(missing), ...change }), false);
        assert.equal(fixture.call(missing, 'preparation'), false);
      }
    });

    test(`${surface} ${role}: zero-command release precedes late confirmation and resume without revival`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment('w-command', 'prepare-01', ['preparation']));
      fixture.deliver({ ...task(grant), ownerConfirmation:false });
      fixture.enqueue({ type:'confirmation', token:grant.token });
      assert.equal(fixture.release(grant, receipt(grant)), true);
      fixture.acknowledge(grant);
      fixture.deliverNext();
      assert.equal(fixture.call(grant, 'preparation'), false);
      fixture.deliver({ type:'resume', token:grant.token });
      assert.equal(fixture.call(grant, 'preparation'), false);
      assert.equal(fixture.journal.filter(row => row.event === 'call-start').length, 0);
      assert.equal(grant.state, 'released');
    });

    test(`${surface} ${role}: stale Proceed checks current actor token control and STOP before every call`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment());
      fixture.deliver(task(grant));
      assert.equal(fixture.call(grant, 'runner'), true);
      for (const slot of [{ ...grant, actor:'a-other' }, { ...grant, token:'other-02' }, { ...grant, state:'released' }]) {
        fixture.changeSlot(slot);
        assert.equal(fixture.call(grant, 'runner'), false);
      }
      fixture.changeSlot(grant); fixture.setSTOP(true);
      assert.equal(fixture.call(grant, 'runner'), false);
      fixture.setSTOP(false); fixture.setActive(false);
      assert.equal(fixture.call(grant, 'runner'), false);
      assert.equal(fixture.journal.filter(row => row.event === 'call-start').length, 1);
    });

    test(`${surface} ${role}: runner-only release does not authorize closure lint`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment());
      fixture.deliver(task(grant));
      assert.equal(fixture.call(grant, 'closure lint'), false);
      assert.equal(fixture.call(grant, 'runner'), true);
      fixture.release(grant, receipt(grant)); fixture.acknowledge(grant);
      assert.equal(fixture.call(grant, 'closure lint'), false);
      const closure = fixture.bind(assignment('a-command', 'closure-02', ['closure lint']));
      fixture.deliver(task(closure));
      assert.equal(fixture.call(closure, 'closure lint'), true);
    });

    test(`${surface} ${role}: initial routing precondition requires a fresh receipt before every suite`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind({ ...assignment(), preconditions:{ routingBeforeSuite:true } });
      fixture.deliver(task(grant));
      assert.equal(fixture.call(grant, 'runner'), false);
      fixture.freshRouting();
      assert.equal(fixture.call(grant, 'runner'), true);
      assert.equal(fixture.call(grant, 'runner'), false);
      fixture.freshRouting();
      assert.equal(fixture.call(grant, 'runner'), true);
      assert.deepEqual(fixture.journal.filter(row => ['routing','call-start','call-end'].includes(row.event))
        .map(row => row.event), ['routing','call-start','call-end','routing','call-start','call-end']);
    });

    test(`${surface} ${role}: changed routing precondition needs acknowledgment and a fresh receipt per suite`, context => {
      const fixture = controlledDelivery(context, text, role);
      const grant = fixture.bind(assignment()); fixture.deliver(task(grant));
      fixture.updatePrecondition(false);
      assert.equal(fixture.call(grant, 'runner'), true);
      fixture.updatePrecondition(true);
      assert.equal(fixture.call(grant, 'runner'), false);
      fixture.freshRouting();
      assert.equal(fixture.call(grant, 'runner'), true);
      assert.equal(fixture.call(grant, 'runner'), false);
      fixture.freshRouting();
      assert.equal(fixture.call(grant, 'runner'), true);
    });
  }

  test(`${surface} orchestrator: official stop rejects stale foreign and outstanding-call observations`, context => {
    const fixture = controlledDelivery(context, text);
    const before = structuredClone(fixture.preserved);
    const grant = fixture.bind(assignment()); fixture.deliver(task(grant));
    const next = assignment('a-next','next-02');
    const observed = () => ({ actor:grant.actor, token:grant.token, scope:grant.scope,
      requestSeq:fixture.journal.length + 1, observedSeq:fixture.journal.length + 2,
      confirmed:true, deliveryPaused:true, status:'idle', background:0, queue:0, pending:0, running:0 });
    for (const change of [{ requestSeq:0 }, { observedSeq:0 }, { seq:0, observedSeq:0 }, { actor:'a-foreign' }, { token:'foreign-02' },
      { scope:['closure lint'] }, { pending:1 }, { running:1 }]) {
      assert.equal(fixture.officialStop(grant, { ...observed(), ...change }), false);
      assert.equal(fixture.transfer(next), false);
      assert.equal(grant.state, 'granted');
    }
    for (const field of ['pending','running']) {
      grant[field] = 1;
      assert.equal(fixture.officialStop(grant, observed()), false);
      assert.equal(fixture.transfer(next), false);
      grant[field] = 0;
    }
    fixture.changeSlot({ ...grant, token:'foreign-02' });
    assert.equal(fixture.officialStop(grant, observed()), false);
    fixture.changeSlot(grant);
    const start = fixture.journal.length;
    assert.equal(fixture.officialStop(grant, observed()), true);
    assert.equal(fixture.transfer(next), true);
    assert.deepEqual(fixture.journal.slice(start).map(row => row.event),
      ['stop-request','stop-observation','stop-ack','prebind','transfer']);
    assert.deepEqual(fixture.preserved, before);
    assert.equal(fixture.call(grant, 'runner'), false);
  });

  test(`${surface} orchestrator: late Hold retains the slot until exact all-calls release acknowledgment`, context => {
    const fixture = controlledDelivery(context, text);
    const grant = fixture.bind(assignment()); fixture.deliver(task(grant));
    fixture.enqueue({ type:'Hold', token:grant.token });
    const next = assignment('a-next', 'next-02');
    assert.equal(fixture.transfer(next), false);
    assert.equal(fixture.call(grant, 'runner'), true);
    fixture.deliverNext();
    assert.equal(fixture.call(grant, 'runner'), false);
    for (const bad of [{ ...receipt(grant), token:'wrong' }, { ...receipt(grant), actor:'a-other' },
      { ...receipt(grant), scope:['closure lint'] }, { ...receipt(grant), pending:1 }, { ...receipt(grant), running:1 }]) {
      assert.equal(fixture.release(grant, bad), false);
      assert.equal(fixture.transfer(next), false);
    }
    grant.pending = 1;
    assert.equal(fixture.release(grant, receipt(grant)), false);
    grant.pending = 0; grant.running = 1;
    assert.equal(fixture.release(grant, receipt(grant)), false);
    grant.running = 0;
    assert.equal(fixture.release(grant, receipt(grant)), true);
    assert.equal(fixture.transfer(next), false);
    fixture.acknowledge(grant);
    assert.equal(fixture.transfer(next), true);
    assert.deepEqual(fixture.journal.filter(row => ['call-start','call-end','release-ack','prebind'].includes(row.event))
      .map(row => row.event), ['prebind','call-start','call-end','release-ack','prebind']);
  });

  test(`${surface} orchestrator: official stop must be verified and preserves unrelated work and receipts`, context => {
    const fixture = controlledDelivery(context, text);
    const before = structuredClone(fixture.preserved);
    const grant = fixture.bind(assignment()); fixture.deliver(task(grant));
    const next = assignment('a-next', 'next-02');
    const observed = () => ({ actor:grant.actor, token:grant.token, scope:grant.scope,
      requestSeq:fixture.journal.length + 1, observedSeq:fixture.journal.length + 2,
      confirmed:true, deliveryPaused:true, status:'idle', background:0, queue:0, pending:0, running:0 });
    for (const change of [{ confirmed:false }, { deliveryPaused:false }, { status:'active' }, { background:1 }, { queue:1 }]) {
      assert.equal(fixture.officialStop(grant, { ...observed(), ...change }), false);
      assert.equal(fixture.transfer(next), false);
    }
    assert.equal(fixture.officialStop(grant, observed()), true);
    assert.equal(fixture.transfer(next), true);
    assert.equal(fixture.call(grant, 'runner'), false);
    assert.deepEqual(fixture.preserved, before);
    assert.equal(fixture.journal.filter(row => row.event === 'stop-ack').length, 1);
    assert.ok(fixture.journal.filter(row => row.event === 'stop-request').every(row => row.actor === grant.actor));
  });
}

test('the old separate-confirmation requirement prevents immediate preparation in the owning contract fixture', context => {
  const requirements = [
    'Require a separate owner confirmation of the task id and active-slot binding.',
    'Do not execute until this instruction has a separate canonical task and the owner confirms',
  ];
  for (const requirement of requirements) {
    for (const role of ['orchestrator', 'approver']) {
      const text = Object.fromEntries(roles.map(name => [name, renderCanonical(name)]));
      text[role] += `\n${requirement}`;
      const fixture = controlledDelivery(context, text);
      const grant = fixture.bind(assignment('a-command', 'prepare-01', ['preparation']));
      assert.equal(fixture.deliver(task(grant)), false);
      assert.equal(fixture.call(grant, 'preparation'), false);
    }
  }
});
