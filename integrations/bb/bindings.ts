import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindingSchema, deliverySchema, launchSchema } from './protocol.js';
import type { Binding, DeliveryState } from './protocol.js';
import type { z } from 'zod';

type BindingSummary = Pick<Binding, 'task' | 'participant' | 'threadId' | 'role' | 'phase'
  | 'projectId' | 'environmentId' | 'hostId' | 'providerId'>;

export function bindingStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    'CREATE TABLE tasks (id TEXT PRIMARY KEY)',
    'CREATE TABLE bindings (task TEXT NOT NULL, participant TEXT NOT NULL, thread TEXT UNIQUE, payload TEXT NOT NULL, PRIMARY KEY(task, participant))',
    'CREATE TABLE launches (task TEXT NOT NULL, participant TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task, participant))',
    'CREATE TABLE deliveries (thread TEXT PRIMARY KEY, payload TEXT NOT NULL)',
  ]);
  const parse = (row: unknown): Binding | undefined => row ? bindingSchema.parse(JSON.parse((row as { payload: string }).payload)) : undefined;
  const delivery = (id: string): DeliveryState => {
    const row = db.prepare('SELECT payload FROM deliveries WHERE thread = ?').get(id) as { payload: string } | undefined;
    return deliverySchema.parse(row ? JSON.parse(row.payload) : {});
  };
  const saveDelivery = (id: string, state: DeliveryState) => db.prepare('INSERT INTO deliveries (thread, payload) VALUES (?, ?) ON CONFLICT(thread) DO UPDATE SET payload = excluded.payload')
    .run(id, JSON.stringify(deliverySchema.parse(state)));
  return {
    delivery,
    updateDelivery(id: string, update: (state: DeliveryState) => void) {
      return db.transaction(() => { const state = delivery(id); update(state); saveDelivery(id, state); return state; })();
    },
    launch(binding: Binding, intent: z.infer<typeof launchSchema>) {
      db.prepare('INSERT INTO launches (task, participant, payload) VALUES (?, ?, ?) ON CONFLICT(task, participant) DO UPDATE SET payload = excluded.payload')
        .run(binding.task, binding.participant, JSON.stringify(launchSchema.parse(intent)));
    },
    launchIntent(binding: Binding) {
      const row = db.prepare('SELECT payload FROM launches WHERE task = ? AND participant = ?').get(binding.task, binding.participant) as { payload: string } | undefined;
      return row ? launchSchema.parse(JSON.parse(row.payload)) : undefined;
    },
    reserve(binding: Binding, create: boolean) {
      db.transaction(() => {
        if (create) db.prepare('INSERT INTO tasks (id) VALUES (?)').run(binding.task);
        else if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(binding.task)) throw new Error('Task is not owned by this plugin');
        db.prepare('INSERT INTO bindings (task, participant, thread, payload) VALUES (?, ?, ?, ?)')
          .run(binding.task, binding.participant, binding.threadId, JSON.stringify(binding));
      })();
    },
    save(binding: Binding) {
      db.prepare('UPDATE bindings SET thread = ?, payload = ? WHERE task = ? AND participant = ?')
        .run(binding.threadId, JSON.stringify(binding), binding.task, binding.participant);
    },
    thread: (id: string) => parse(db.prepare('SELECT payload FROM bindings WHERE thread = ?').get(id)),
    participant: (task: string, id: string) => parse(db.prepare('SELECT payload FROM bindings WHERE task = ? AND participant = ?').get(task, id)),
    task: (id: string) => parse(db.prepare("SELECT payload FROM bindings WHERE task = ? AND participant = 'orchestrator'").get(id)),
    inventory({ task, participant, limit = 50, cursor = 0 }: { task?: string; participant?: string; limit?: number; cursor?: number } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('bindings limit must be an integer from 1 to 100');
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('bindings cursor must be a nonnegative safe integer');
      const rows = db.prepare(`SELECT rowid AS rowId, task, participant, thread AS threadId,
        json_extract(payload, '$.role') AS role, json_extract(payload, '$.phase') AS phase,
        json_extract(payload, '$.projectId') AS projectId, json_extract(payload, '$.environmentId') AS environmentId,
        json_extract(payload, '$.hostId') AS hostId, json_extract(payload, '$.providerId') AS providerId
        FROM bindings WHERE rowid > ? AND (? IS NULL OR task = ?) AND (? IS NULL OR participant = ?)
        ORDER BY rowid LIMIT ?`).iterate(cursor, task ?? null, task ?? null, participant ?? null, participant ?? null, limit + 1) as
        IterableIterator<BindingSummary & { rowId: number }>;
      const items: BindingSummary[] = [];
      let lastCursor = cursor;
      try {
        let current = rows.next();
        while (!current.done) {
          const { rowId, ...item } = current.value;
          const next = rows.next();
          items.push(item);
          const page = { items, nextCursor: next.done ? null : rowId };
          if (Buffer.byteLength(JSON.stringify(page)) > 64 * 1024) {
            items.pop();
            if (!items.length) throw new Error(`Binding summary at row ${rowId} exceeds 64 KiB; correct its oversized stored identity fields before retrying this cursor`);
            return { items, nextCursor: lastCursor };
          }
          lastCursor = rowId;
          if (items.length === limit || next.done) return page;
          current = next;
        }
        return { items, nextCursor: null };
      } finally { rows.return?.(); }
    },
    list: (): Binding[] => (db.prepare('SELECT payload FROM bindings ORDER BY task, participant').all()).map((row: unknown) => parse(row)!),
  };
}
