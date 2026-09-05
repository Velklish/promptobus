// Stand-in availability adapters for the routing suite. Not `*.test.mjs` — the
// runner (run.mjs) takes only those from the directory, so this file is never a
// file of the run.
//
// The substitution sits exactly where a real adapter will: at the contract
// ([model-routing.ts](../src/model-routing.ts)), one method, `probe`. Nothing
// below starts a binary, and nothing may: three of the four states a preflight has
// to handle — a harness that never answers, one whose limit is spent, one nobody
// is logged into — are states a live account is not asked to be in for a test run.
//
// `FAKE_TOKEN` is why the leaky stub exists. It is a secret shaped exactly like
// what an adapter could pick up out of harness output, handed to the preflight in
// fields the snapshot does not declare. The suite then greps the written cache for
// it: the closed-shape projection is what must keep it off disk, and a check that
// never handed one over would pass on a writer that copies everything.
export const FAKE_TOKEN = 'promptobus-fake-probe-token-9f3a2c';

/** Counts probes so a check can prove that a path asked nothing. */
export function counter() {
  return { probes: 0 };
}

/**
 * Authenticated, two models, one limit window — and a fistful of fields the
 * contract does not declare, carrying the token, an address and raw output.
 */
export function availableStub(count = null, { windows = true } = {}) {
  return {
    probe() {
      if (count) count.probes += 1;
      return {
        state: 'available',
        reason: null,
        message: 'authenticated; 2 models listed',
        checkedAt: new Date().toISOString(),
        source: 'probe',
        resetAt: null,
        version: '0.0.0',
        models: [{ model: 'stub-deep' }, { model: 'stub-quick', flags: ['preview'] }],
        ...(windows ? { windows: [{ id: '5h', usedPercent: 40, lengthSec: 18000, resetAt: null }] } : {}),
        // Not in the contract and not in the schema. This is the leak under test.
        token: FAKE_TOKEN,
        account: 'someone@example.invalid',
        rawOutput: `logged in as someone@example.invalid (${FAKE_TOKEN})`,
      };
    },
  };
}

/** Answers long after any budget the suite can wait out. The timer is unref'd: it must not hold the run open. */
export function slowStub(count = null, { delayMs = 30_000 } = {}) {
  return {
    probe() {
      if (count) count.probes += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          state: 'available',
          reason: null,
          message: 'answered, but far too late',
          checkedAt: new Date().toISOString(),
          source: 'probe',
        }), delayMs).unref();
      });
    },
  };
}

/** The limit is spent. With `resetAt` it expires by itself; without one it is the sticky kind. */
export function exhaustedStub(count = null, { resetAt = null } = {}) {
  return {
    probe() {
      if (count) count.probes += 1;
      return {
        state: 'exhausted',
        reason: 'subscription_exhausted',
        message: resetAt ? 'limit spent; the harness named a reset' : 'limit spent; no reset time given',
        checkedAt: new Date().toISOString(),
        source: 'probe',
        resetAt,
      };
    },
  };
}

/** The binary is there, nobody is logged in. */
export function unauthenticatedStub(count = null) {
  return {
    probe() {
      if (count) count.probes += 1;
      return {
        state: 'unavailable',
        reason: 'not_authenticated',
        message: 'the binary is there; this account is not logged in',
        checkedAt: new Date().toISOString(),
        source: 'probe',
        resetAt: null,
      };
    },
  };
}

/** Throws. An adapter is third-party code to the preflight, and a thrown error is one of its answers. */
export function throwingStub(count = null) {
  return {
    probe() {
      if (count) count.probes += 1;
      throw new Error(`harness command blew up (${FAKE_TOKEN})`);
    },
  };
}

/**
 * Answers exactly what it is given, contract or not. The seam for the checks that
 * ask what the preflight does with an answer outside the four states, the nine
 * reasons and the three sources — a misspelt `quota-unknown` is the mistake an
 * adapter author actually makes, and it must not reach a file that promises to
 * validate.
 */
export function answeringStub(verdict, count = null) {
  return {
    probe() {
      if (count) count.probes += 1;
      return verdict;
    },
  };
}

/** Maps a harness name to its stub — the `adapterFor` the preflight takes. */
export function adapterMap(stubs) {
  return (harness) => {
    const stub = stubs[harness];
    if (!stub) throw new Error(`no stub adapter for ${harness}`);
    return stub;
  };
}
