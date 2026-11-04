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
const encoded = 'eyJmb3JtYXQiOjEsImJ1aWxkSWQiOiJiNTljNDA2My0yNGNkLTQxY2UtOGI4MS1hZTYzZjUwYjFmZmQiLCJwbHVnaW5WZXJzaW9uIjoiMC4yLjAtcmMuMiIsImlucHV0U2hhMjU2IjoiMzgyM2U0Njc1MDE5NTBhNzJlNzE0NTZkMDA3ZmQ3MWFjZjA3N2U4ZGZjMmE5ZmYyYjQ4Mzc3MzQ1NjcxZTNjMCIsImlucHV0cyI6eyJjb21tYW5kQ29tcGlsZXIiOlt7Im5hbWUiOiJ0eXBlc2NyaXB0IiwidmVyc2lvbiI6IjcuMC4yIiwic2hhMjU2IjoiNTk3ODJjZjNkMmJiMzk2MWU4MzVmMDg0MTg5YTUzMTVkYjk5ZjE5NDFhZDZkYzJlMTVhMWI0Y2MwNWMwODk2YSJ9LHsibmFtZSI6IkB0eXBlc2NyaXB0L3R5cGVzY3JpcHQtZGFyd2luLWFybTY0IiwidmVyc2lvbiI6IjcuMC4yIiwic2hhMjU2IjoiZmJjNmYzN2IwZjkxOTM4MThhZDc4OWRjN2M4NzYxZTlmNjAyMDQ3ZjI2OTc2MjA5OGU1OWZjYWU5NDc4ZDhhNyJ9LHsibmFtZSI6IkB0eXBlcy9ub2RlIiwidmVyc2lvbiI6IjIyLjE5LjExIiwic2hhMjU2IjoiODg2ZjU3M2JhZWNhMTU0ZWRjN2QyZDM4ODljNGE1ZDc3YWUxNTViZDY3ZTlmYmU3NmU4Y2NjY2JmMTFjNDYxMSJ9LHsibmFtZSI6InVuZGljaS10eXBlcyIsInZlcnNpb24iOiI2LjIxLjAiLCJzaGEyNTYiOiI0ZmIxODE0YzIzNjAyMTkxZmM1ZTQ4ZjU3NjU1NWU5OTc4ZTU1NGEyMDUzNzA4MzY4YmM2MzJiY2IxNDAyZjM0In1dLCJzb3VyY2VTaGEyNTYiOiIzNTZjNDM4NTZlODZjNmU2OTkyODNlNGVkOWJiNDVhNzNhYmY0OWMyZWI0OTUyMDliMzk3ZDZmYzgzMzAzYTQzIiwic291cmNlUmV2aXNpb24iOiI0YWFmMjE4OTYxMjRhOGJkNDM2YzBiMjBmNzk0NGM1MTkwMTBjYTkyIiwic291cmNlRGlydHkiOmZhbHNlLCJsb2NrU2hhMjU2IjoiYjZjMDFmZWVjYTUzMTViMmM0NDJmZjJkOWE2NzQ1ZDI5NGQwNGQ5NTg2NGM1NDRhYTA2NzVmZWZlZTc1NmNlZSIsImJ1aWxkZXJWZXJzaW9uIjoiMC40OC4xIiwiZGVwZW5kZW5jaWVzIjpbeyJuYW1lIjoiQGdldC1iYi9wbHVnaW4tc2RrIiwidmVyc2lvbiI6IjAuNi4xMDQiLCJzaGEyNTYiOiI2ZDY5NDk2YmRhMDg3NWFlYWEyN2U4M2YxZjUwOTEzODFhNTgyMmU2ZDkxNzdjYmUxM2E3ODA4ZWVkODA2YTQ4In0seyJuYW1lIjoiQHRhbnN0YWNrL3F1ZXJ5LWNvcmUiLCJ2ZXJzaW9uIjoiNS4xMDUuMCIsInNoYTI1NiI6IjkxNjcwN2MwOWJhMmEyNDEwYzJiN2U5YThlNmJiMGViYjhhZmFmOTNlMmRjY2Y3Y2Y4MjZmMDNkYWJkZmY2NzcifSx7Im5hbWUiOiJAdGFuc3RhY2svcmVhY3QtcXVlcnkiLCJ2ZXJzaW9uIjoiNS4xMDUuMCIsInNoYTI1NiI6IjU1NmM5ZGNmMTAzMWMxYzNmYjE5YjM5NTJiYjZiNzQyMDI3YmJmMzA1MmVkNzkxNjE1Mjg3YjhkMTA0OGYxNTcifSx7Im5hbWUiOiJjcm9zcy1zcGF3biIsInZlcnNpb24iOiI3LjAuNiIsInNoYTI1NiI6ImE0MzRiZGE4MDUwYWNmYjI3NTg1MmU5MmNhNDk4MTA1YTBlMzNiYjFkNjdkNTgwZjI0MWMzNGVmYmY3OTE3NDcifSx7Im5hbWUiOiJpc2V4ZSIsInZlcnNpb24iOiIyLjAuMCIsInNoYTI1NiI6IjE4MzBkOWQyN2U0YzUzZTMyYWQwOGVjYzZhMTYzZmM1MDE4MmU2MzEzOWFkOGQwYWJkNTk3MGNkYzM1MjliMjQifSx7Im5hbWUiOiJwYXRoLWtleSIsInZlcnNpb24iOiIzLjEuMSIsInNoYTI1NiI6IjhjNjJhOTM3MTllNTNmMTNmMTE1ZmRhZmM5NzdkNGM5YTNmZjJlOGJjOGYxNmI4MWQ0MTQyZWUyNDQyYTM2OWUifSx7Im5hbWUiOiJwcm9tcHRvYnVzIiwidmVyc2lvbiI6IjAuMzIuMyIsInNoYTI1NiI6IjE0OTNiNTQ1ZWU3ZDJlZGY0NmFhNzlmNWY2ZGFjOTczZTU2MTEzOTE5MzA1YjBkZGZkNzY2Y2I0MDMwZDlmY2IifSx7Im5hbWUiOiJzaGViYW5nLWNvbW1hbmQiLCJ2ZXJzaW9uIjoiMi4wLjAiLCJzaGEyNTYiOiJkNTExMmUzNDVjODQxZmM4NjhhYzA3YWQwOWUwZGMxMjg4ZTdlNzU5ZmQyZjkyZjE1ZTcwNzU3ZjFlNzVhZTg3In0seyJuYW1lIjoic2hlYmFuZy1yZWdleCIsInZlcnNpb24iOiIzLjAuMCIsInNoYTI1NiI6IjUzODFhNGFjNzZkN2QyODgwZjI0NWM3ODFmMjUwZTVmMGEzOTIwOGQ2ODMzNTY1Njg0ZmE4OGRhNzM2MDA0OTYifSx7Im5hbWUiOiJ3aGljaCIsInZlcnNpb24iOiIyLjAuMiIsInNoYTI1NiI6ImU0YmVhNGZjNjc0ZmZjZmIyYTM4MzRiM2Q0NTY1MDkyNDYwYzVlYmE5ZmVlM2YxNTBiOTYyODdhYjNjNTc4NWUifSx7Im5hbWUiOiJ6b2QiLCJ2ZXJzaW9uIjoiNC42LjYiLCJzaGEyNTYiOiIxNmMzNzk3MmJkN2MzZTkxYjk1YTJiYzA2MzU2NmFjY2JhNjk3YjU5NzkzZGY1NWIyZGUwODkwZjA5MmVmZWMyIn1dLCJjb25zdW1lckludGVncmF0aW9uU2hhMjU2IjpudWxsLCJjb25zdW1lckJ1bmRsZVNoYTI1NiI6bnVsbH19';
const identity = encoded.startsWith('__') ? null : buildIdentitySchema.parse(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
if (identity) {
    for (const dependency of identity.inputs.dependencies)
        Object.freeze(dependency);
    for (const compiler of identity.inputs.commandCompiler ?? [])
        Object.freeze(compiler);
    if (identity.inputs.commandCompiler)
        Object.freeze(identity.inputs.commandCompiler);
    Object.freeze(identity.inputs.dependencies);
    Object.freeze(identity.inputs);
    Object.freeze(identity);
}
export const BUILD_IDENTITY = identity;
