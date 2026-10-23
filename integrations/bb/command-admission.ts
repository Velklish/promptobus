import { z } from 'zod';
import { bindingSchema, commandAdmissionSchema, toolsFor } from './protocol.js';
import type { CommandBinding } from './protocol.js';
import { validateLaunchContext } from './launch-context.js';

const inputSchema = z.union([z.object({ binding: bindingSchema, commandId: z.string().min(1) }).strict(), commandAdmissionSchema]);

export function parseCommandAdmission(input: unknown): { binding: CommandBinding; commandId: string } {
  const parsed = inputSchema.parse(input);
  if ('binding' in parsed) return parsed;
  const launch = parsed.launchContext;
  if (launch.control.mode !== 'current') throw new Error('bounded execution requires canonical current control');
  const { owner } = launch.control.reference, { grant } = launch;
  const binding: CommandBinding = { task: grant.task, participant: grant.actor, role: parsed.role,
    projectId: owner.projectId, hostId: owner.hostId, root: owner.root,
    environmentPath: grant.scope.repository, branch: grant.scope.branch, baseSha: grant.scope.base, launchContext: launch };
  validateLaunchContext(binding, launch, toolsFor(binding.role));
  return { binding, commandId: parsed.commandId };
}
