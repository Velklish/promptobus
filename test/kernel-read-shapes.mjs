export const DARWIN_IMAGE_SHA256 = '0eb8dd0083cd4f8eb379f99f891ccb87783fc4fd412ab412ca8da323d61778a1';
const pidOf = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 0x7fffffff;

export function recognizeKernelRead(line, platform = process.platform) {
  if (platform !== 'darwin' || typeof line !== 'string' || Buffer.byteLength(line) > 16384) return null;
  const fields = line.split('\t');
  if (fields.length !== 3 || fields[0] !== fields[1]) return null;
  let value;
  try { value = JSON.parse(fields[2]); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.platform !== 'darwin' || !pidOf(value.pid)) return null;
  let keys, reason;
  if (fields[0] === '/usr/bin/osascript' && value.shape === 'process-image' && value.bodySha256 === DARWIN_IMAGE_SHA256) {
    keys = ['version', 'platform', 'shape', 'pid', 'bodySha256']; reason = 'reviewed proc_pidpath JXA body';
  } else if (fields[0] === '/bin/ps' && value.shape === 'process-parent') {
    keys = ['version', 'platform', 'shape', 'pid']; reason = 'exact single-process ppid read';
  } else if (fields[0] === '/bin/ps' && value.shape === 'process-lifetime') {
    keys = ['version', 'platform', 'shape', 'pid']; reason = 'exact single-process stat and lstart read';
  } else if (fields[0] === '/usr/sbin/lsof' && value.shape === 'process-files') {
    keys = ['version', 'platform', 'shape', 'pid']; reason = 'exact single-process device and inode read';
  } else return null;
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return null;
  return { shape: value.shape, reason, pid: value.pid };
}
