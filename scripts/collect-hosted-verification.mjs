// Decode a full fs/read API response and verify the remote archive digest BEFORE stopping its sandbox.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function collectReceiptArchive(payload, expectedSha256, target) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Expected remote SHA-256 is required');
  let bytes;
  if (Buffer.isBuffer(payload)) bytes = payload;
  else {
    const file = payload.result ?? payload;
    if (typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error('Archive response is truncated or is not canonical base64; keep the sandbox running');
    bytes = Buffer.from(file.data, 'base64');
    if (file.size !== undefined && bytes.length !== file.size) throw new Error('Archive byte count mismatch; keep the sandbox running');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Archive checksum mismatch; keep the sandbox running');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
  return { status: 'verified', bytes: bytes.length, sha256, archive: target };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , responseFile, expectedSha256, target] = process.argv;
  if (!responseFile || !expectedSha256 || !target) throw new Error('Usage: node scripts/collect-hosted-verification.mjs <download-or-api-response> <remote-sha256> <archive.tar.gz>');
  const raw = readFileSync(responseFile);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = raw; }
  console.log(JSON.stringify(collectReceiptArchive(payload, expectedSha256, target)));
}
