import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const buildIdentitySchema = z.object({
  format: z.literal(1),
  buildId: z.uuid(),
  pluginVersion: z.string().min(1).max(100),
  inputSha256: sha256,
  inputs: z.object({
    commandCompiler: z.array(z.object({ name: z.string().max(200), version: z.string().max(100), sha256 }).strict()).max(20).optional(),
    sourceSha256: sha256,
    sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
    sourceDirty: z.boolean().nullable(),
    lockSha256: sha256,
    builderVersion: z.string().max(100).nullable(),
    dependencies: z.array(z.object({ name: z.string().max(200), version: z.string().max(100), sha256 }).strict()).max(100),
    consumerIntegrationSha256: sha256.nullable(),
    consumerBundleSha256: sha256.nullable(),
  }).strict(),
}).strict();
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

const encoded = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
const identity = encoded.startsWith('__') ? null : buildIdentitySchema.parse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
if (identity) {
  for (const dependency of identity.inputs.dependencies) Object.freeze(dependency);
  for (const compiler of identity.inputs.commandCompiler ?? []) Object.freeze(compiler);
  if (identity.inputs.commandCompiler) Object.freeze(identity.inputs.commandCompiler);
  Object.freeze(identity.inputs.dependencies); Object.freeze(identity.inputs); Object.freeze(identity);
}
export const BUILD_IDENTITY = identity;
