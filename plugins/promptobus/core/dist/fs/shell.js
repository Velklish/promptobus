const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellQuote(arg) {
    const s = String(arg);
    return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
