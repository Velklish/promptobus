import type { Driver, ReservationLookup, ReservationState, UnstartedReservation } from '../../dist/driver.js';
import type { UnstartedReservation as RootRequest } from '../../dist/index.js';

declare const options: Driver['options'];
declare const phrases: Driver['phrases'];
const legacy: Driver = {
  id: 'custom', options, phrases,
  capabilities: { spawn: false, attach: false, activation: 'pull', inspect: false, stop: false },
};
const lookup: ReservationLookup = { ref: 'synthetic', registryHome: '/synthetic/registry' };
const request: UnstartedReservation = {
  ...lookup, home: '/synthetic/task', task: 'task', address: 'worker:test', launchId: 'generation',
  owner: { pid: 42, birth: 'synthetic-birth' },
};
const rootRequest: RootRequest = request;
const observer = (input: ReservationLookup): ReservationState => input.ref ? 'unknown' : 'dead';
const extended: Driver = { ...legacy, reservationState: observer, retireUnstarted: input => input === rootRequest };
extended.reservationState?.(lookup);
extended.retireUnstarted?.(request);
// @ts-expect-error Unknown session words cannot authorize reservation reclamation.
const badState: ReservationState = 'gone';
// @ts-expect-error A public request cannot carry a private session payload.
const badRequest: ReservationLookup = { ...lookup, record: { secret: true } };
// @ts-expect-error Retirement always identifies the launch generation.
extended.retireUnstarted?.(lookup);
void badState; void badRequest;
