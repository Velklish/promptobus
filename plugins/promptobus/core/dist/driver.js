// The driver contract.
// [reference/05-drivers.md#the-driver-contract](../docs/reference/05-drivers.md#the-driver-contract)
import { addressOf, GateError } from './protocol.js';
import { PromptobusError } from './v1/errors.js';
import { assignParticipant, putParticipant } from './v1/store.js';
/** How the participant is named to a person: the address if the adapter wrote one, otherwise the record id. */
function named(participant) {
    return addressOf(participant) ?? String(participant?.id ?? '');
}
// A limit word plus a retry phrase. A year is required to parse: `Date.parse` fills a missing one with 2001.
const RESET_PHRASE = /\b(?:try again at|resets(?:\s+at)?)\s+([^\n]+)/i;
/** The retry time a refusal names, or `null` when it names none. Harness-neutral: one fact, not a taxonomy.
 * `seen` is when the harness wrote the line: a wall time in a named zone means its next occurrence after that. */
export function namedReset(text, seen = null) {
    const s = typeof text === 'string' ? text : '';
    if (!/\blimit\b/i.test(s))
        return null;
    const said = RESET_PHRASE.exec(s)?.[1]?.trim().replace(/\.$/, '').trim();
    if (!said)
        return null;
    const plain = said.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
    const ms = /\b\d{4}\b/.test(plain) ? Date.parse(plain) : wallTimeAfter(plain, seen);
    return { said, at: Number.isFinite(ms) ? new Date(ms).toISOString() : null };
}
// `6:20am (Europe/Moscow)`: a 12-hour wall time and an IANA zone, nothing else. No zone, no time.
const WALL_TIME = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\(([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)\)$/i;
function wallTimeAfter(said, seen) {
    const m = WALL_TIME.exec(said);
    if (!m || seen === null || !Number.isFinite(seen))
        return NaN;
    const [hour, minute] = [Number(m[1]), Number(m[2] ?? 0)];
    if (hour < 1 || hour > 12 || minute > 59)
        return NaN;
    const zone = m[4];
    let offset;
    try {
        offset = zoneOffset(zone);
    }
    catch {
        return NaN;
    }
    const local = new Date(seen + offset(seen));
    const hh = (hour % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
    for (let day = 0; day <= 1; day += 1) {
        const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hh, minute);
        const at = wall - offset(wall - offset(seen));
        if (at > seen)
            return at;
    }
    return NaN;
}
// The zone's offset from UTC at an instant, read back through `Intl`; an unknown zone throws RangeError.
function zoneOffset(zone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    return (utc) => {
        const part = (type) => Number(fmt.formatToParts(utc).find((p) => p.type === type)?.value);
        const floor = utc - (((utc % 1000) + 1000) % 1000);
        return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - floor;
    };
}
/** Whether a named reset still stands at `now`. A time that did not parse stands until the refusal clears. */
export function resetAhead(reset, now = Date.now()) {
    if (!reset)
        return false;
    return reset.at === null || Date.parse(reset.at) > now;
}
/** The reset time for a person: the instant, or the harness's words marked as unread. */
export function resetText(reset) {
    return reset.at ?? `a time the harness named as «${reset.said}», which does not parse`;
}
export function createRegistry({ drivers, fallback = null }) {
    if (!drivers || typeof drivers !== 'object')
        throw new GateError('registry: a harness → driver map is required');
    for (const [harness, driver] of Object.entries(drivers)) {
        if (!driver?.id || !driver?.capabilities) {
            throw new GateError(`registry: driver «${harness}» has no id or capabilities — the contract is not met`);
        }
    }
    if (fallback !== null && !Object.hasOwn(drivers, fallback)) {
        throw new GateError(`registry: fallback «${fallback}» is not named in the harness → driver map`);
    }
    return { drivers: { ...drivers }, fallback };
}
/** Harness name of the record. Field absent entirely — the registry `fallback` is taken (a former-CLI record). */
export function harnessOf(participant, registry) {
    const declared = participant?.harness;
    if (typeof declared === 'string' && declared.trim())
        return declared.trim();
    return registry.fallback;
}
/** Driver by harness name. Unknown — refusal, and the refusal is BEFORE any store write. */
export function driverFor(registry, harness) {
    const known = Object.keys(registry.drivers);
    if (!harness) {
        throw new GateError('the participant harness is not named, and the registry declared no fallback — '
            + `known harnesses: ${known.join(', ') || 'none'}`);
    }
    const driver = registry.drivers[harness];
    if (!driver) {
        throw new GateError(`harness «${harness}» is unknown — known: ${known.join(', ') || 'none'}`);
    }
    return driver;
}
/** Whether the driver can do what is asked. Asked BEFORE the store changes: a declared capability
 * without an operation is the same refusal as an undeclared one. */
export function requireCapability(driver, op) {
    if (!driver.capabilities?.[op]) {
        throw new GateError(`driver «${driver.id}» cannot ${op} — this operation is not declared by it`);
    }
    if (typeof driver[op] !== 'function') {
        throw new GateError(`driver «${driver.id}» declared ${op} but has no such operation`);
    }
}
/** Whether the driver declared a harness property. Such flags have no operation, so an undeclared one
 * is read as "no" — the silent "it probably can" is what the flag exists against. */
export function hasFeature(driver, feature) {
    return driver.capabilities?.[feature] === true;
}
/** Whether the driver wakes on its own. A pull-driver does not wake the session — it organises its own polling. */
export function pushes(driver) {
    return driver.capabilities?.activation === 'push';
}
/** Opaque session reference of the participant record. Former-CLI records carried it in `name`;
 * migration gave them a field of their own, and v1 has no second source. */
export function sessionRefOf(participant) {
    const ref = participant?.sessionRef;
    return typeof ref === 'string' && ref ? ref : null;
}
/** Write a participant the driver launched or attached to. The registry is asked FIRST: a refusal
 * after the write would leave a participant in the journal with nothing to wake it by. */
export function openParticipant(home, task, participant, registry, { mode = 'managed', assignment = false } = {}) {
    const driver = driverFor(registry, harnessOf(participant, registry));
    requireCapability(driver, mode === 'managed' ? 'spawn' : 'attach');
    const ref = sessionRefOf(participant);
    if (!ref) {
        throw new GateError(`participant ${named(participant)}: driver «${driver.id}» received no session reference — `
            + 'there will be nothing to recognise its session by later');
    }
    // The record is given to the caller in full: whoever appends a session id must put back THE SAME
    // record. A store refusal becomes a `GateError` — a busy journal is lawful for two lift commands.
    let record = { ...participant, ...participantDriverFields(driver, { mode, ref }) };
    let meta;
    try {
        meta = (assignment ? assignParticipant : putParticipant)(home, task, record, () => new Date());
        record = meta.participants.find(p => p.id === record.id);
    }
    catch (e) {
        if (e instanceof PromptobusError)
            throw new GateError(e.message);
        throw e;
    }
    return { driver, meta, record };
}
/** Participant mode. Absent entirely means `managed` — the former CLI left spawn records. A
 * participant with no session reference has no mode: nobody launched a session behind it. */
export function modeOf(participant) {
    if (!sessionRefOf(participant))
        return null;
    const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
    // Field absent entirely — `managed`: that is how the former CLI wrote participants, and spawn launched the session.
    if (!raw)
        return 'managed';
    // An unfamiliar non-empty value is a typo or junk from a hand edit, and a default here is
    // destructive: "if not attached, then managed" would stop a session the driver did not launch.
    return raw === 'managed' || raw === 'attached' ? raw : null;
}
/** Whether the driver owns this session: it launched it — it is the one to stop it. */
export function isManaged(participant) {
    return modeOf(participant) === 'managed';
}
/** Stop a participant session — a driver operation, not a command. Only `managed` may be stopped, and
 * the refusal is explicit; the outcome is awaited, since the driver may wait for the harness. */
export async function stopParticipant(participant, registry) {
    const driver = driverFor(registry, harnessOf(participant, registry));
    requireCapability(driver, 'stop');
    const mode = modeOf(participant);
    if (mode !== 'managed') {
        // An unfamiliar value is named literally: "there is no mode" about a field with something in it
        // would read as "there is no field", and the two are fixed differently.
        const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
        const said = mode ?? (raw ? `«${raw}» — the contract does not know this mode` : 'there is no session behind it');
        throw new GateError(`participant ${named(participant)}: mode ${mode ? `«${mode}»` : said} — `
            + `driver «${driver.id}» did not launch this session and has no right to dispose of it`);
    }
    return driver.stop(sessionRefOf(participant));
}
/** Driver fields in the participant record: harness, mode and the capabilities snapshot. */
export function participantDriverFields(driver, { mode, ref }) {
    return {
        harness: driver.id,
        mode,
        sessionRef: ref,
        capabilities: { ...driver.capabilities },
    };
}
/** No one to ask: there is no driver, or it does not look. Neither death nor life — unknown. */
const UNKNOWN = { state: 'unknown', busy: false, stall: null, id: null };
/** Snapshot of participant sessions, taken once per heartbeat. One unparsed session drops the whole
 * snapshot; one INVALID record does not — it gets `unknown`, and the walk goes on. */
export function snapshotSessions(participants, registry) {
    const view = {};
    for (const p of participants ?? []) {
        const ref = sessionRefOf(p);
        const addr = addressOf(p);
        if (!addr || !ref)
            continue;
        let seen;
        try {
            const driver = driverFor(registry, harnessOf(p, registry));
            if (!driver.capabilities?.inspect || typeof driver.inspect !== 'function') {
                view[addr] = UNKNOWN;
                continue;
            }
            seen = driver.inspect(ref);
        }
        catch (e) {
            view[addr] = e instanceof GateError
                ? { ...UNKNOWN, stall: { kind: 'unknown', reason: e.message } }
                : UNKNOWN;
            continue;
        }
        if (seen === null)
            return null;
        view[addr] = seen;
    }
    return view;
}
// Availability adapter contract, declared next door and re-exported here: a driver implements both,
// and an author should not find out that its two halves live behind two imports.
export * from './model-routing.js';
