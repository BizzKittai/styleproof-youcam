#!/usr/bin/env node
// A transaction probe, not an app/server. No dependencies and no automatic retries.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(PROJECT, '../../..');
export const API_ORIGIN = 'https://yce-api-01.makeupar.com';
export const POLL_INTERVAL_MS = 10_000;
export const MAX_TOTAL_POLLS = 30;
export const INPUTS = Object.freeze([
  { id: 'synthetic-adult-model', name: 'synthetic-adult-model.png', bytes: 1969964, width: 1024, height: 1536,
    sha256: '4899e37d3c02ff680852747e1608cfe97eecc7e861fdc29ad566ec648dedb98d' },
  { id: 'garment-a-forest-crewneck', name: 'garment-a-forest-crewneck.png', bytes: 1953638, width: 1254, height: 1254,
    sha256: 'ed786800cfeedda7f0bffd83fe0fdedf1211dfe0e7032f169ff239c7a019af6b' },
]);
const ASSETS = 'work/income-expansion/revenue-execution-2026-10-28T1911/assets';
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

export class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const stop = code => { throw new ProbeError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Provider IDs are opaque (documented file IDs contain base64 + / =).
const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 512
  && !/[\u0000-\u0020\u007f-\u009f]/.test(value) && value !== '.' && value !== '..';

function httpsURL(value) {
  let url;
  try { url = new URL(value); } catch { stop('URL_REJECTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) stop('URL_REJECTED');
  return url;
}
export function assertApiURL(value) {
  const url = httpsURL(value);
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/s2s/v2.0/')) stop('API_HOST_REJECTED');
  return url.href;
}
export function assertSignedS3URL(value) {
  const url = httpsURL(value);
  const host = url.hostname;
  const s3 = host === 's3.amazonaws.com' || /^(?:[a-z0-9][a-z0-9.-]*\.)?s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)
    || /^[a-z0-9][a-z0-9.-]*\.s3\.amazonaws\.com$/.test(host);
  const q = url.searchParams;
  if (!s3 || q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
    || !/^[a-f0-9]{64}$/i.test(q.get('X-Amz-Signature') ?? '')
    || !q.get('X-Amz-Credential') || !/^\d{8}T\d{6}Z$/.test(q.get('X-Amz-Date') ?? '')
    || !/^\d+$/.test(q.get('X-Amz-Expires') ?? '')
    || Number(q.get('X-Amz-Expires')) < 1 || Number(q.get('X-Amz-Expires')) > 604800) stop('SIGNED_S3_URL_REJECTED');
  return url.href;
}

export async function loadApprovedInputs({ root = ROOT, readInput = readFile } = {}) {
  const rootReal = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(root, ASSETS, 'provenance.json'), 'utf8'));
  const loaded = [];
  for (const fixed of INPUTS) {
    const relative = `${ASSETS}/${fixed.name}`;
    const declared = manifest.assets?.find(asset => asset.id === fixed.id);
    if (!declared || declared.path !== relative || declared.sha256 !== fixed.sha256
      || declared.bytes !== fixed.bytes || declared.synthetic !== true
      || declared.realPersonReferenceSupplied !== false || declared.thirdPartyPhotoOrLogoSupplied !== false) stop('MANIFEST_MISMATCH');
    const resolved = await realpath(path.join(root, relative));
    if (!resolved.startsWith(`${rootReal}${path.sep}`)) stop('INPUT_PATH_REJECTED');
    const bytes = Buffer.from(await readInput(resolved));
    if (bytes.length !== fixed.bytes || createHash('sha256').update(bytes).digest('hex') !== fixed.sha256) stop('INPUT_HASH_MISMATCH');
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) !== fixed.width || bytes.readUInt32BE(20) !== fixed.height) stop('INPUT_PNG_MISMATCH');
    loaded.push({ ...fixed, data: bytes });
  }
  return loaded;
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readPrivateJournal(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) stop('JOURNAL_NOT_PRIVATE');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validateJournal(state) {
  if (!object(state) || state.version !== 1 || state.apiOrigin !== API_ORIGIN
    || state.inputHashes?.join(',') !== INPUTS.map(x => x.sha256).join(',')
    || !Number.isInteger(state.metadataPostAttempts) || state.metadataPostAttempts < 0 || state.metadataPostAttempts > 1
    || !Number.isInteger(state.taskPostAttempts) || state.taskPostAttempts < 0 || state.taskPostAttempts > 1
    || !Number.isInteger(state.uploadPutAttempts) || state.uploadPutAttempts < 0 || state.uploadPutAttempts > 2
    || !Number.isInteger(state.pollAttempts) || state.pollAttempts < 0 || state.pollAttempts > MAX_TOTAL_POLLS
    || (state.taskId && !identifier(state.taskId))) stop('JOURNAL_INVALID');
}
function summary(state, dryRun = false) {
  return { dryRun, phase: state.phase, inputs: INPUTS.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
    metadataPostAttempts: state.metadataPostAttempts, uploadPutAttempts: state.uploadPutAttempts,
    taskPostAttempts: state.taskPostAttempts, pollAttempts: state.pollAttempts,
    hasTaskId: Boolean(state.taskId), resultURLRecordedPrivately: Boolean(state.resultURL),
    resultDownloaded: Boolean(state.resultDownloaded), realProviderSuccess: state.phase === 'success',
    nominalTaskUnits: 2, monetaryOrBalanceVerificationPerformedByScript: false };
}
async function bodyBounded(response, maximum) {
  if (!response.body) stop('EMPTY_RESPONSE');
  const chunks = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > maximum) { await response.body.cancel().catch(() => {}); stop('RESPONSE_TOO_LARGE'); }
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}
function validUploadPlans(payload, inputs, apiKey) {
  const files = payload?.data?.files;
  if (payload.status !== 200 || !Array.isArray(files) || files.length !== 2) stop('UPLOAD_SCHEMA_REJECTED');
  const seen = new Set();
  return inputs.map(input => {
    const file = files.find(item => item.file_name === input.name);
    if (!file || seen.has(file.file_id) || !identifier(file.file_id) || file.content_type !== 'image/png'
      || !Array.isArray(file.requests) || file.requests.length !== 1) stop('UPLOAD_SCHEMA_REJECTED');
    seen.add(file.file_id);
    const request = file.requests[0];
    if (request.method !== 'PUT' || !object(request.headers)) stop('UPLOAD_SCHEMA_REJECTED');
    const url = assertSignedS3URL(request.url);
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (!/^(?:content-type|content-length|x-amz-[a-z0-9-]+)$/.test(lower)
        || lower in headers || typeof value !== 'string' || /[\r\n]/.test(value) || value.includes(apiKey)) stop('UPLOAD_HEADER_REJECTED');
      headers[lower] = value;
    }
    if (headers['content-type'] !== 'image/png' || headers['content-length'] !== String(input.bytes)) stop('UPLOAD_HEADER_REJECTED');
    return { input, fileId: file.file_id, url, headers };
  });
}

export async function runProbe({ execute = false, resume = false, downloadResult = false, apiKey,
  runtimeDir = path.join(PROJECT, 'runtime'), root = ROOT, fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollLimit = 12, readInput } = {}) {
  const inputs = await loadApprovedInputs({ root, readInput });
  if (!Number.isInteger(pollLimit) || pollLimit < 1 || pollLimit > MAX_TOTAL_POLLS) stop('POLL_LIMIT_REJECTED');
  if (!execute) return summary({ phase: 'validated_no_network', metadataPostAttempts: 0,
    uploadPutAttempts: 0, taskPostAttempts: 0, pollAttempts: 0 }, true);
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.trim() !== apiKey || /[\r\n]/.test(apiKey)) stop('API_KEY_REQUIRED');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(runtimeDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) stop('RUNTIME_PATH_REJECTED');
  await chmod(runtimeDir, 0o700);
  await syncDirectory(path.dirname(runtimeDir));
  await syncDirectory(runtimeDir);
  const journal = path.join(runtimeDir, 'one-shot-probe.json');
  const lockPath = path.join(runtimeDir, 'one-shot-probe.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { stop('LOCKED_STOP_AND_INSPECT'); }
  let state;
  const save = () => atomicJSON(journal, state);
  async function transport(url, options) {
    try { return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45_000) }); }
    catch { stop('TRANSPORT_FAILED_NO_RETRY'); }
  }
  async function api(method, pathname, body) {
    const url = assertApiURL(`${API_ORIGIN}${pathname}`);
    const response = await transport(url, { method, headers: { Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) stop(`PROVIDER_HTTP_${response.status}`);
    try { return JSON.parse((await bodyBounded(response, 1_000_000)).toString('utf8')); }
    catch (error) { if (error instanceof ProbeError) throw error; stop('PROVIDER_JSON_REJECTED'); }
  }
  async function download() {
    if (!downloadResult || !state.resultURL || state.resultDownloaded) return;
    if (state.resultDownloadAttempted) stop('RESULT_DOWNLOAD_ALREADY_ATTEMPTED');
    const url = assertSignedS3URL(state.resultURL);
    state.resultDownloadAttempted = true;
    await save();
    const response = await transport(url, { method: 'GET', headers: {} });
    if (!response.ok) stop(`RESULT_HTTP_${response.status}`);
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!['image/png', 'image/jpeg'].includes(type)) stop('RESULT_TYPE_REJECTED');
    const bytes = await bodyBounded(response, 20_000_000);
    if (!(type === 'image/png' ? bytes.subarray(0, 8).equals(PNG_MAGIC) : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))) stop('RESULT_IMAGE_REJECTED');
    const file = path.join(runtimeDir, type === 'image/png' ? 'result.png' : 'result.jpg');
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    state.resultDownloaded = true;
    state.resultSHA256 = createHash('sha256').update(bytes).digest('hex');
    await save();
  }
  try {
    state = await readPrivateJournal(journal);
    if (state) {
      validateJournal(state);
      if (!resume) stop('EXISTING_JOURNAL_USE_RESUME_NO_NEW_POST');
      if (!state.taskId) stop('NO_TASK_ID_FOR_RESUME_DO_NOT_REPOST');
      if (state.phase === 'success') { await download(); return summary(state); }
      if (['provider_error', 'unknown_task_status'].includes(state.phase)) stop('TERMINAL_TASK_DO_NOT_REPOST');
    } else {
      if (resume) stop('NO_JOURNAL_FOR_RESUME');
      state = { version: 1, apiOrigin: API_ORIGIN, inputHashes: INPUTS.map(x => x.sha256),
        phase: 'before_metadata_post', metadataPostAttempts: 1, uploadPutAttempts: 0,
        taskPostAttempts: 0, pollAttempts: 0, createdAtUTC: new Date().toISOString() };
      await save(); // Persist intent BEFORE POST. A lost response never permits another POST.
      const metadata = await api('POST', '/s2s/v2.0/file', { files: inputs.map(x => ({
        content_type: 'image/png', file_name: x.name, file_size: x.bytes })) });
      const plans = validUploadPlans(metadata, inputs, apiKey); // Validate BOTH targets before first PUT.
      state.fileIds = plans.map(x => x.fileId);
      for (const plan of plans) {
        state.phase = 'before_upload_put';
        state.uploadPutAttempts += 1;
        await save();
        const response = await transport(plan.url, { method: 'PUT', headers: plan.headers, body: plan.input.data });
        if (!response.ok) stop(`UPLOAD_HTTP_${response.status}`);
      }
      state.phase = 'before_task_post';
      state.taskPostAttempts = 1;
      await save();
      const created = await api('POST', '/s2s/v2.0/task/cloth-v4', {
        src_file_id: state.fileIds[0], ref_file_id: state.fileIds[1], garment_category: 'upper_body' });
      if (created.status !== 200 || !identifier(created.data?.task_id)) stop('TASK_RESPONSE_AMBIGUOUS_DO_NOT_REPOST');
      state.taskId = created.data.task_id;
      state.phase = 'polling';
      await save();
    }
    for (let index = 0; index < pollLimit && state.pollAttempts < MAX_TOTAL_POLLS; index += 1) {
      await sleep(POLL_INTERVAL_MS);
      state.pollAttempts += 1;
      state.phase = 'polling';
      await save();
      const polled = await api('GET', `/s2s/v2.0/task/cloth-v4/${encodeURIComponent(state.taskId)}`);
      const data = polled.data;
      if (polled.status !== 200 || !object(data)) stop('POLL_SCHEMA_REJECTED');
      if (data.error != null || ['error', 'failed', 'failure'].includes(data.task_status)) {
        state.phase = 'provider_error'; await save(); stop('PROVIDER_TASK_ERROR');
      }
      if (data.task_status === 'success') {
        state.phase = 'success';
        try { state.resultURL = assertSignedS3URL(data.results?.url); }
        catch { state.resultURLRejected = true; await save(); stop('RESULT_URL_REJECTED_NO_DOWNLOAD'); }
        await save(); await download(); return summary(state);
      }
      if (!['run', 'running', 'pending', 'queued', 'processing'].includes(data.task_status)) {
        state.phase = 'unknown_task_status'; await save(); stop('UNKNOWN_TASK_STATUS');
      }
    }
    state.phase = 'poll_limit_stop_preserve_task';
    await save();
    return summary(state);
  } catch (error) {
    // Never print raw provider responses, transport exceptions, keys, signed URLs or stack traces.
    throw error instanceof ProbeError ? error : new ProbeError('LOCAL_FAILURE_STOP_AND_INSPECT');
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Set(process.argv.slice(2));
  const allowed = new Set(['--execute', '--resume', '--download-result']);
  if ([...flags].some(flag => !allowed.has(flag))) {
    console.error(JSON.stringify({ ok: false, code: 'UNKNOWN_ARGUMENT' })); process.exitCode = 1;
  } else {
    const execute = flags.has('--execute');
    runProbe({ execute, resume: flags.has('--resume'), downloadResult: flags.has('--download-result'),
      apiKey: execute ? process.env.YOUCAM_API_KEY : undefined })
      .then(value => console.log(JSON.stringify({ ok: true, ...value }, null, 2)))
      .catch(error => { console.error(JSON.stringify({ ok: false, code: error.code ?? 'LOCAL_FAILURE_STOP_AND_INSPECT' })); process.exitCode = 1; });
  }
}
