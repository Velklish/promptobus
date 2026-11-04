import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { shellQuote } from '../dist/fs/shell.js';
import { privateDirectory } from './service-state.js';
export function writeRootExecPlan(directory, command, generation = randomUUID()) {
    if (process.platform === 'win32')
        throw new Error('The root exec launcher requires a POSIX shell');
    const values = [command.file, ...command.args, ...Object.values(command.env).filter(value => typeof value === 'string')];
    if (!command.file || !/^[a-f0-9-]{36}$/.test(generation) || values.some(value => value.includes('\0'))
        || Object.keys(command.env).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
        throw new Error('The root exec plan requires a command, valid environment names and no NUL bytes');
    }
    privateDirectory(directory);
    const file = path.join(directory, `exec-${generation}.sh`);
    const consume = 'const fs=require("node:fs");try{fs.unlinkSync(Buffer.from(fs.readFileSync(0,"utf8").trim(),"base64").toString("utf8"))}'
        + 'catch{process.stderr.write("Private root exec plan could not be consumed\\n");process.exitCode=1}';
    const lines = [`${shellQuote(process.execPath)} --input-type=commonjs -e ${shellQuote(consume)} <<'PROMPTOBUS_PRIVATE_PLAN' || exit $?`,
        Buffer.from(file).toString('base64'), 'PROMPTOBUS_PRIVATE_PLAN'];
    for (const [name, value] of Object.entries(command.env)) {
        if (value === null)
            lines.push(`unset ${name}`);
        else if (value !== undefined)
            lines.push(`export ${name}=${shellQuote(value)}`);
    }
    lines.push(`exec ${[command.file, ...command.args].map(shellQuote).join(' ')}`);
    writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    return file;
}
