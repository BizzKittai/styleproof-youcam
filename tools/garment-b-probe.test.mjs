import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API_ORIGIN, INPUTS, MAX_TOTAL_POLLS, POLL_INTERVAL_MS, assertApiURL, PROBE_SCOPE, APPROVAL_FILENAME, runProbe } from './garment-b-probe.mjs';

const KEY = 'OFFLINE_FAKE_B_KEY_NEVER_VALID';
const SOURCE_PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// No test may reach a real transport, including tests of missing approval.
globalThis.fetch = async () => assert.fail('GLOBAL_NETWORK_FORBIDDEN_IN_OFFLINE_TESTS');
const signed = name => `https://test-bucket.s3.us-west-2.amazonaws.com/${name}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=offline&X-Amz-Date=20261030T170000Z&X-Amz-Expires=900&X-Amz-Signature=${'a'.repeat(64)}`;
const reply = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fakeProvider({ badUploadHost = false, badUploadHeaders = false, lostMetadata = false,
  lostTask = false, failedFirstPoll = false, running = false, redirect = false, badResult = false, opaqueIds = false } = {}) {
  const calls = [];
  let polls = 0;
  const fileIds = opaqueIds ? ['file+zero/part=', 'ref+one/part='] : ['file_0', 'file_1'];
  const taskId = opaqueIds ? 'task+/opaque==' : 'task_offline_1';
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    if (url.startsWith(API_ORIGIN)) assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    else assert.equal(options.headers.Authorization, undefined, 'API bearer must never reach storage');
    if (url === `${API_ORIGIN}/s2s/v2.0/file`) {
      if (lostMetadata) throw new Error(`deliberate private transport text ${KEY}`);
      const body = JSON.parse(options.body);
      assert.equal(body.files.length, 2);
      return reply({ status: 200, data: { files: INPUTS.map((input, index) => ({
        file_name: input.name, content_type: 'image/png', file_id: fileIds[index],
        requests: [{ method: 'PUT', url: badUploadHost && index === 1 ? signed(input.name).replace('test-bucket.s3.us-west-2.amazonaws.com', 'evil.invalid') : signed(input.name),
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(input.bytes),
            ...(badUploadHeaders ? { Authorization: `Bearer ${KEY}` } : {}) } }],
      })) } });
    }
    if (options.method === 'PUT') return new Response(null, { status: redirect ? 307 : 200, headers: redirect ? { Location: 'https://evil.invalid/' } : {} });
    if (url === `${API_ORIGIN}/s2s/v2.0/task/cloth-v4`) {
      assert.deepEqual(JSON.parse(options.body), { src_file_id: fileIds[0], ref_file_id: fileIds[1], garment_category: 'upper_body' });
      if (lostTask) throw new Error(`lost response containing ${KEY} and ${signed('private')}`);
      return reply({ status: 200, data: { task_id: taskId } });
    }
    if (url === `${API_ORIGIN}/s2s/v2.0/task/cloth-v4/${encodeURIComponent(taskId)}`) {
      polls += 1;
      if (failedFirstPoll && polls === 1) throw new Error('temporary offline transport failure');
      return reply({ status: 200, data: { error: null, task_status: running ? 'running' : 'success',
        results: running ? null : { url: badResult ? signed('result.png').replace('test-bucket.s3.us-west-2.amazonaws.com', 'evil.invalid') : signed('result.png') } } });
    }
    if (url === signed('result.png') && options.method === 'GET') {
      return new Response(Buffer.from('89504e470d0a1a0a00000000', 'hex'), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    assert.fail('Unexpected fake request');
  };
  return { calls, fetchImpl, count(method, suffix) { return calls.filter(x => x.method === method && x.url === `${API_ORIGIN}${suffix}`).length; } };
}
async function fixture(t, { approval = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styleproof-b-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'source-assets'));
  const manifest = JSON.parse(await readFile(path.join(SOURCE_PROJECT, 'source-assets/provenance.json'), 'utf8'));
  await writeFile(path.join(root, 'source-assets/provenance.json'), JSON.stringify(manifest));
  for (const asset of manifest.assets) await copyFile(path.join(SOURCE_PROJECT, asset.path), path.join(root, asset.path));
  const runtimeDir = path.join(root, 'runtime', 'garment-b');
  const approvalValue = {
    version: 1, scope: PROBE_SCOPE, apiOrigin: API_ORIGIN, humanApprovalReceived: true,
    approvedAtUTC: '2026-10-30T18:00:00Z', maximumTaskCreates: 1, nominalTaskUnits: 2,
    noAutomaticRetry: true, approvedInputHashes: INPUTS.map(input => input.sha256),
    offlineFixtureOnly: true, evidence: 'OFFLINE_TEST_FIXTURE_NOT_REAL_HUMAN_APPROVAL',
  };
  const writeApproval = async (overrides = {}) => {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(runtimeDir, APPROVAL_FILENAME), JSON.stringify({ ...approvalValue, ...overrides }), { mode: 0o600 });
  };
  if (approval) await writeApproval();
  const sleeps = [];
  return { root, runtimeDir, writeApproval, sleep: async ms => { sleeps.push(ms); assert.equal(ms, POLL_INTERVAL_MS); }, sleeps,
    journal: async () => JSON.parse(await readFile(path.join(runtimeDir, 'one-shot-probe.json'), 'utf8')) };
}
const exec = (f, api, extra = {}) => runProbe({ execute: true, apiKey: KEY, root: f.root,
  sleep: f.sleep, fetchImpl: api.fetchImpl, ...extra });

test('default dry-run validates fixed originals, without a key, fetch or journal', async t => {
  const f = await fixture(t, { approval: false });
  const result = await runProbe({ root: f.root, fetchImpl: () => assert.fail('network in dry-run') });
  assert.equal(result.dryRun, true);
  assert.equal(result.inputs.length, 2);
  await assert.rejects(stat(path.join(f.root, 'runtime')), { code: 'ENOENT' });
});

test('exact successful probe: 1 metadata POST, 2 PUTs, 1 task POST and explicit 10s poll; no download by default', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const result = await exec(f, api);
  assert.equal(api.count('POST', '/s2s/v2.0/file'), 1);
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 1);
  assert.equal(api.calls.filter(x => x.method === 'PUT').length, 2);
  assert.equal(api.calls.length, 5);
  assert.equal(result.realProviderSuccess, true);
  assert.equal(result.resultDownloaded, false);
  assert.equal((await stat(path.join(f.runtimeDir, 'one-shot-probe.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.runtimeDir)).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(result), /OFFLINE_FAKE|X-Amz|https:/);
});

test('changed approved portable input is rejected before any request', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const readInput = async name => { const data = Buffer.from(await readFile(name)); data[100] ^= 1; return data; };
  await assert.rejects(exec(f, api, { readInput }), { code: 'INPUT_HASH_MISMATCH' });
  assert.equal(api.calls.length, 0);
});

test('documented opaque + / = file IDs are preserved; task ID is URL-encoded, including on resume', async t => {
  const f = await fixture(t); const api = fakeProvider({ opaqueIds: true, failedFirstPoll: true });
  await assert.rejects(exec(f, api), { code: 'TRANSPORT_FAILED_NO_RETRY' });
  const result = await exec(f, api, { resume: true });
  assert.equal(result.realProviderSuccess, true);
  assert.deepEqual((await f.journal()).fileIds, ['file+zero/part=', 'ref+one/part=']);
  assert.equal((await f.journal()).taskId, 'task+/opaque==');
  const gets = api.calls.filter(call => call.url.startsWith(`${API_ORIGIN}/s2s/v2.0/task/cloth-v4/`));
  assert.equal(gets.length, 2);
  assert.ok(gets.every(call => call.url.endsWith('/task%2B%2Fopaque%3D%3D')));
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 1);
});

test('second malicious upload host rejects the entire plan before either PUT or generation', async t => {
  const f = await fixture(t); const api = fakeProvider({ badUploadHost: true });
  await assert.rejects(exec(f, api), { code: 'SIGNED_S3_URL_REJECTED' });
  assert.equal(api.calls.length, 1);
  assert.equal((await f.journal()).taskPostAttempts, 0);
});

test('provider storage headers cannot leak bearer credentials', async t => {
  const f = await fixture(t); const api = fakeProvider({ badUploadHeaders: true });
  await assert.rejects(exec(f, api), { code: 'UPLOAD_HEADER_REJECTED' });
  assert.equal(api.calls.length, 1);
});

test('lost generation response persists intent; resume and restart cannot make a second POST', async t => {
  const f = await fixture(t); const api = fakeProvider({ lostTask: true });
  await assert.rejects(exec(f, api), { code: 'TRANSPORT_FAILED_NO_RETRY' });
  const saved = await f.journal();
  assert.equal(saved.taskPostAttempts, 1);
  assert.equal(saved.taskId, undefined);
  await assert.rejects(exec(f, api, { resume: true }), { code: 'NO_TASK_ID_FOR_RESUME_DO_NOT_REPOST' });
  await assert.rejects(exec(f, api), { code: 'EXISTING_JOURNAL_USE_RESUME_NO_NEW_POST' });
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 1);
});

test('lost metadata response cannot be re-posted either', async t => {
  const f = await fixture(t); const api = fakeProvider({ lostMetadata: true });
  await assert.rejects(exec(f, api), { code: 'TRANSPORT_FAILED_NO_RETRY' });
  await assert.rejects(exec(f, api, { resume: true }), { code: 'NO_TASK_ID_FOR_RESUME_DO_NOT_REPOST' });
  assert.equal(api.count('POST', '/s2s/v2.0/file'), 1);
});

test('an interrupted known task resumes only GET polling, never POST/upload', async t => {
  const f = await fixture(t); const api = fakeProvider({ failedFirstPoll: true });
  await assert.rejects(exec(f, api), { code: 'TRANSPORT_FAILED_NO_RETRY' });
  const result = await exec(f, api, { resume: true });
  assert.equal(result.realProviderSuccess, true);
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 1);
  assert.equal(api.calls.filter(x => x.method === 'PUT').length, 2);
  assert.equal(result.pollAttempts, 2);
});

test('poll limit is persisted across resumes, with at most12total GETs', async t => {
  const f = await fixture(t); const api = fakeProvider({ running: true });
  await exec(f, api, { pollLimit: 5 });
  await exec(f, api, { resume: true, pollLimit: MAX_TOTAL_POLLS });
  const count = api.calls.length;
  const result = await exec(f, api, { resume: true, pollLimit: MAX_TOTAL_POLLS });
  assert.equal(result.pollAttempts, MAX_TOTAL_POLLS);
  assert.equal(api.calls.length, count);
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 1);
});

test('redirect and wrong API host cannot send bearer or create a task', async t => {
  assert.throws(() => assertApiURL('https://yce-api-01.makeupar.com.evil.invalid/s2s/v2.0/file'), { code: 'API_HOST_REJECTED' });
  const f = await fixture(t); const api = fakeProvider({ redirect: true });
  await assert.rejects(exec(f, api), { code: 'UPLOAD_HTTP_307' });
  assert.equal(api.count('POST', '/s2s/v2.0/task/cloth-v4'), 0);
});

test('result download requires explicit flag and exact signed provider result', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const result = await exec(f, api, { downloadResult: true });
  assert.equal(result.resultDownloaded, true);
  assert.equal(api.calls.filter(x => x.url === signed('result.png')).length, 1);
  assert.equal((await stat(path.join(f.runtimeDir, 'result.png'))).mode & 0o777, 0o600);
  const again = await exec(f, api, { resume: true, downloadResult: true });
  assert.equal(again.resultDownloaded, true);
  assert.equal(api.calls.filter(x => x.url === signed('result.png')).length, 1);
});

test('unapproved result URL is never downloaded, despite successful provider status', async t => {
  const f = await fixture(t); const api = fakeProvider({ badResult: true });
  await assert.rejects(exec(f, api, { downloadResult: true }), { code: 'RESULT_URL_REJECTED_NO_DOWNLOAD' });
  assert.equal(api.calls.length, 5);
  assert.equal((await f.journal()).resultDownloadAttempted, undefined);
});


test('no actual B approval means no request and no task journal', async t => {
  const f = await fixture(t, { approval: false }); const api = fakeProvider();
  await assert.rejects(exec(f, api), { code: 'B_APPROVAL_REQUIRED' });
  assert.equal(api.calls.length, 0);
  await assert.rejects(stat(path.join(f.runtimeDir, 'one-shot-probe.json')), { code: 'ENOENT' });
});

test('approval must bind exact B scope, both input hashes and a single generation', async t => {
  const f = await fixture(t); const api = fakeProvider();
  for (const wrong of [
    { scope: 'garment-a' }, { approvedInputHashes: INPUTS.map(input => input.sha256).reverse() },
    { maximumTaskCreates: 2 }, { nominalTaskUnits: 20 }, { humanApprovalReceived: false },
    { noAutomaticRetry: false }, { approvedAtUTC: 'not-a-time' }, { apiOrigin: 'https://evil.invalid' },
  ]) {
    await f.writeApproval(wrong);
    await assert.rejects(exec(f, api), { code: 'B_APPROVAL_MISMATCH' });
  }
  assert.equal(api.calls.length, 0);
});

test('approval cannot be public-readable or a symlink', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const approval = path.join(f.runtimeDir, APPROVAL_FILENAME);
  await chmod(approval, 0o644);
  await assert.rejects(exec(f, api), { code: 'B_APPROVAL_NOT_PRIVATE' });
  await rm(approval);
  const target = path.join(f.root, 'foreign-approval.json');
  await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, approval);
  await assert.rejects(exec(f, api), { code: 'B_APPROVAL_NOT_PRIVATE' });
  assert.equal(api.calls.length, 0);
});

test('B never changes historical A state and rejects copied A journals', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const A = path.join(f.root, 'runtime', 'one-shot-probe.json');
  const sentinel = '{"historical":"A sentinel remains unchanged"}';
  await writeFile(A, sentinel, { mode: 0o600 });
  await writeFile(path.join(f.runtimeDir, 'one-shot-probe.json'), JSON.stringify({
    version: 1, apiOrigin: API_ORIGIN, inputHashes: INPUTS.map(input => input.sha256),
    metadataPostAttempts: 0, taskPostAttempts: 0, uploadPutAttempts: 0, pollAttempts: 0,
  }), { mode: 0o600 });
  await assert.rejects(exec(f, api), { code: 'JOURNAL_INVALID' });
  assert.equal(api.calls.length, 0);
  assert.equal(await readFile(A, 'utf8'), sentinel);
});

test('successful B writes only its fixed journal and leaves an existing A journal unchanged', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const A = path.join(f.root, 'runtime', 'one-shot-probe.json');
  const sentinel = '{"historical":"Completed A remains immutable"}';
  await writeFile(A, sentinel, { mode: 0o600 });
  const result = await exec(f, api);
  assert.equal(result.realProviderSuccess, true);
  assert.equal(await readFile(A, 'utf8'), sentinel);
  assert.equal((await f.journal()).probeScope, PROBE_SCOPE);
  assert.deepEqual((await f.journal()).inputHashes, INPUTS.map(input => input.sha256));
  assert.equal(path.basename(f.runtimeDir), 'garment-b');
});

test('fixed B runtime cannot be overridden and runtime symlinks cannot escape clone', async t => {
  const f = await fixture(t, { approval: false }); const api = fakeProvider();
  await assert.rejects(exec(f, api, { runtimeDir: path.join(f.root, 'other-runtime') }), { code: 'FIXED_RUNTIME_SCOPE' });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'styleproof-b-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await chmod(outside, 0o755);
  await symlink(outside, path.join(f.root, 'runtime'));
  await assert.rejects(exec(f, api), { code: 'RUNTIME_PATH_REJECTED' });
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.equal(api.calls.length, 0);
});

test('B-only manifest rejects garment A substitution before network', async t => {
  const f = await fixture(t); const api = fakeProvider();
  const name = path.join(f.root, 'source-assets/provenance.json');
  const manifest = JSON.parse(await readFile(name, 'utf8'));
  manifest.assets.find(asset => asset.id === INPUTS[1].id).path = 'source-assets/garment-a-forest-crewneck.png';
  await writeFile(name, JSON.stringify(manifest));
  await assert.rejects(exec(f, api), { code: 'MANIFEST_MISMATCH' });
  assert.equal(api.calls.length, 0);
});

test('portable CLI dry-run works from an isolated clone, unrelated CWD and no environment', async t => {
  const f = await fixture(t, { approval: false });
  await mkdir(path.join(f.root, 'tools'));
  const source = path.join(SOURCE_PROJECT, 'tools/garment-b-probe.mjs');
  const cloneTool = path.join(f.root, 'tools/garment-b-probe.mjs');
  await copyFile(source, cloneTool);
  // Garment A is not read by B, despite being an available project asset.
  await rm(path.join(f.root, 'source-assets/garment-a-forest-crewneck.png'));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cloneTool], { cwd: os.tmpdir(), env: {} });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true); assert.equal(result.dryRun, true);
  assert.equal(result.probeScope, PROBE_SCOPE);
  assert.deepEqual(result.inputs.map(input => input.name), ['synthetic-adult-model.png', 'garment-b-rust-shirt.png']);
  await assert.rejects(stat(path.join(f.root, 'runtime')), { code: 'ENOENT' });
});
