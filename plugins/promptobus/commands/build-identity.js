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
const encoded = 'eyJmb3JtYXQiOjEsImJ1aWxkSWQiOiI0MDdmMDI1Ny03NmYyLTQ1MmUtOGQ4ZC1lZGZkODdkZWQ0MzEiLCJwbHVnaW5WZXJzaW9uIjoiMC4yLjEiLCJpbnB1dFNoYTI1NiI6ImU0MjdmMzlkMDFlNWY5ODE1NmEyY2I1MjI5YzJjYjUxZTkwYTFlNjU2YTg0MDZlMThhYjhkYmYyNDBmYzU4NDciLCJpbnB1dHMiOnsiY29tbWFuZENvbXBpbGVyIjpbeyJuYW1lIjoidHlwZXNjcmlwdCIsInZlcnNpb24iOiI3LjAuMiIsInNoYTI1NiI6IjU5NzgyY2YzZDJiYjM5NjFlODM1ZjA4NDE4OWE1MzE1ZGI5OWYxOTQxYWQ2ZGMyZTE1YTFiNGNjMDVjMDg5NmEifSx7Im5hbWUiOiJAdHlwZXNjcmlwdC90eXBlc2NyaXB0LWRhcndpbi1hcm02NCIsInZlcnNpb24iOiI3LjAuMiIsInNoYTI1NiI6ImZiYzZmMzdiMGY5MTkzODE4YWQ3ODlkYzdjODc2MWU5ZjYwMjA0N2YyNjk3NjIwOThlNTlmY2FlOTQ3OGQ4YTcifSx7Im5hbWUiOiJAdHlwZXMvbm9kZSIsInZlcnNpb24iOiIyMi4xOS4xMSIsInNoYTI1NiI6Ijg4NmY1NzNiYWVjYTE1NGVkYzdkMmQzODg5YzRhNWQ3N2FlMTU1YmQ2N2U5ZmJlNzZlOGNjY2NiZjExYzQ2MTEifSx7Im5hbWUiOiJ1bmRpY2ktdHlwZXMiLCJ2ZXJzaW9uIjoiNi4yMS4wIiwic2hhMjU2IjoiNGZiMTgxNGMyMzYwMjE5MWZjNWU0OGY1NzY1NTVlOTk3OGU1NTRhMjA1MzcwODM2OGJjNjMyYmNiMTQwMmYzNCJ9XSwic291cmNlU2hhMjU2IjoiZTU5N2VhYjA0MjU5MzRmNTgyNDgyNDg5NDIxODhmYzg4MzhhMjUwMDM4OTZkZDQxMjgyYWJkOTk2MmJlMzk3ZSIsInNvdXJjZVJldmlzaW9uIjoiNjE0MzE3NTA1NjA4YzIyYWE1MGVkMWFiNDE2NDg1Zjg1NjMxNWQ3ZSIsInNvdXJjZURpcnR5IjpmYWxzZSwibG9ja1NoYTI1NiI6IjAyMTAwMDQ3NDQ2NDVhNGRkOWVhZDQ0NWQ3ZTQ0NTVhYWJjNjNiMTA5ZDZjYzc5YTQxNjM5ODU2ZDExNTkwYzIiLCJidWlsZGVyVmVyc2lvbiI6IjAuNDkuMCIsImRlcGVuZGVuY2llcyI6W3sibmFtZSI6IkBnZXQtYmIvcGx1Z2luLXNkayIsInZlcnNpb24iOiIwLjYuMTMyIiwic2hhMjU2IjoiMTVmYWFjY2FlMDk0MjQ3ZDVhNGI2MmJkNTNhOTg2MWIzZWZlNmM1NWNkMTYwNThlYTE1MTQ1NWFiOGYxNDZhNyJ9LHsibmFtZSI6IkB0YW5zdGFjay9xdWVyeS1jb3JlIiwidmVyc2lvbiI6IjUuMTA3LjEiLCJzaGEyNTYiOiIxZTdiMjA3YjI5NDNiOTU4YTJlOTI2MjkyMGJmMjc2MzBhYTllOGUyYmEzODE3ODMwN2FlMDZkMGU1Y2FmNzk0In0seyJuYW1lIjoiQHRhbnN0YWNrL3JlYWN0LXF1ZXJ5IiwidmVyc2lvbiI6IjUuMTA3LjEiLCJzaGEyNTYiOiI2YmZhNzNmNjA0MzNiNmM5NTEwM2Q0ODViODRjNDdmNjYxM2YxOGJjZTE0NWE4ODA5YmNkZDAwMWNlNTlkNWJkIn0seyJuYW1lIjoiY3Jvc3Mtc3Bhd24iLCJ2ZXJzaW9uIjoiNy4wLjYiLCJzaGEyNTYiOiJhNDM0YmRhODA1MGFjZmIyNzU4NTJlOTJjYTQ5ODEwNWEwZTMzYmIxZDY3ZDU4MGYyNDFjMzRlZmJmNzkxNzQ3In0seyJuYW1lIjoiaXNleGUiLCJ2ZXJzaW9uIjoiMi4wLjAiLCJzaGEyNTYiOiIxODMwZDlkMjdlNGM1M2UzMmFkMDhlY2M2YTE2M2ZjNTAxODJlNjMxMzlhZDhkMGFiZDU5NzBjZGMzNTI5YjI0In0seyJuYW1lIjoicGF0aC1rZXkiLCJ2ZXJzaW9uIjoiMy4xLjEiLCJzaGEyNTYiOiI4YzYyYTkzNzE5ZTUzZjEzZjExNWZkYWZjOTc3ZDRjOWEzZmYyZThiYzhmMTZiODFkNDE0MmVlMjQ0MmEzNjllIn0seyJuYW1lIjoicHJvbXB0b2J1cyIsInZlcnNpb24iOiIwLjMzLjAiLCJzaGEyNTYiOiIzMTI3OTQxZmYyNGMyMjI3YjkwYTExYjU2MjAwNWViYjBkM2VlYzY1YjYyZWUxMmI2YWFlOWNjM2ViZGM1NjhiIn0seyJuYW1lIjoic2hlYmFuZy1jb21tYW5kIiwidmVyc2lvbiI6IjIuMC4wIiwic2hhMjU2IjoiZDUxMTJlMzQ1Yzg0MWZjODY4YWMwN2FkMDllMGRjMTI4OGU3ZTc1OWZkMmY5MmYxNWU3MDc1N2YxZTc1YWU4NyJ9LHsibmFtZSI6InNoZWJhbmctcmVnZXgiLCJ2ZXJzaW9uIjoiMy4wLjAiLCJzaGEyNTYiOiI1MzgxYTRhYzc2ZDdkMjg4MGYyNDVjNzgxZjI1MGU1ZjBhMzkyMDhkNjgzMzU2NTY4NGZhODhkYTczNjAwNDk2In0seyJuYW1lIjoid2hpY2giLCJ2ZXJzaW9uIjoiMi4wLjIiLCJzaGEyNTYiOiJlNGJlYTRmYzY3NGZmY2ZiMmEzODM0YjNkNDU2NTA5MjQ2MGM1ZWJhOWZlZTNmMTUwYjk2Mjg3YWIzYzU3ODVlIn0seyJuYW1lIjoiem9kIiwidmVyc2lvbiI6IjQuNi43Iiwic2hhMjU2IjoiYTViNzhjNGFmMDYyNTAxOWFjMDUxMzVlYjU0NmJhZTE3OTNhZDJhODhhMDY1YjE0NmVjMzg3YWJjZTZkNTZjYSJ9XSwiY29uc3VtZXJJbnRlZ3JhdGlvblNoYTI1NiI6bnVsbCwiY29uc3VtZXJCdW5kbGVTaGEyNTYiOm51bGx9fQ==';
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
