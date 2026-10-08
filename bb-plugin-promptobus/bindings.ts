import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindingSchema } from './protocol.js';
import type { Binding } from './protocol.js';

export function bindingStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    'CREATE TABLE tasks (id TEXT PRIMARY KEY)',
    'CREATE TABLE bindings (task TEXT NOT NULL, participant TEXT NOT NULL, thread TEXT UNIQUE, payload TEXT NOT NULL, PRIMARY KEY(task, participant))',
  ]);
  const parse = (row: unknown): Binding | undefined => row ? bindingSchema.parse(JSON.parse((row as { payload: string }).payload)) : undefined;
  return {
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
    task: (id: string) => parse(db.prepare("SELECT payload FROM bindings WHERE task = ? AND participant = 'orchestrator'").get(id)),
    list: (): Binding[] => (db.prepare('SELECT payload FROM bindings ORDER BY task, participant').all()).map((row: unknown) => parse(row)!),
  };
}
