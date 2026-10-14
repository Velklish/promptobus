import path from 'node:path';

export function assertBbDirectCommand(command) {
  let executable = command[0];
  if (path.basename(executable ?? '') === 'env') {
    let index = 1;
    if (command[index] === '--') index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index] ?? '')) index++;
    executable = command[index];
    if (!executable || executable.startsWith('-') || path.basename(executable) === 'env') {
      throw new Error('Unsupported env launcher; record the runner executable directly');
    }
  }
  if (!executable || ['sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'ksh93', 'csh', 'tcsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']
    .includes(path.basename(executable).toLowerCase())) {
    throw new Error('Record the runner executable directly; shell pipeline return codes are unsupported');
  }
}
