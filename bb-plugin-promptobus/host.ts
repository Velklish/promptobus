import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { reviewerFiles } from 'promptobus/bb-reviewer';
import { hostContract } from './contract.js';
import { engineOperation } from './engine-host.js';

export { experimental_providerBridge } from './reviewer-bridge.js';

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { read: async ({ root, name, args }) => reviewerFiles([root])(name, args),
    engine: async (input, context) => { context.signal.throwIfAborted(); return engineOperation(input); } },
});
