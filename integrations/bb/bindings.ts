import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindingSchema, deliverySchema, launchSchema } from './protocol.js';
import type { Binding, DeliveryState } from './protocol.js';
import type { z } from 'zod';

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
    list: (): Binding[] => (db.prepare('SELECT payload FROM bindings ORDER BY task, participant').all()).map((row: unknown) => parse(row)!),
  };
}
