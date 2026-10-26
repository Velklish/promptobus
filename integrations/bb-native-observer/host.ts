import { randomUUID } from 'node:crypto';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { hostContract } from './contract.js';
import { readProjection, readTasks } from './projection.js';

const instance = randomUUID();
export default experimental_defineHostEntry({ contract: hostContract, handlers: {
  snapshot: selection => readProjection(selection, instance, process.pid),
  tasks: selection => readTasks(selection),
} });
