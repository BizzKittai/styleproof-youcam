import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSET_HASHES, evidenceTotals, initialState, loadManifest, resetView, selectedEvidence, selectOption, setView, validateManifest, viewerPresentation } from '../app/manifest.mjs';
import { createHandler, CSP } from './serve-demo.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const manifest = JSON.parse(await readFile(path.join(app, 'demo-manifest.json'), 'utf8'));
const copy = () => structuredClone(manifest);
async function localRequest(url, method = 'GET') {
  let status, headers, body;
  await createHandler()({ url, method }, { writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } });
  return { status, headers, body };
}

test('phase2 manifest contains two independently recorded genuine outputs and four ledger-verified units', () => {
  const data = validateManifest(copy());
  for (const option of data.options) {
    assert.equal(option.status, 'recorded_success'); assert.equal(option.units.actual, 2);
    assert.equal(option.units.measurement, 'provider_usage_ledger');
  }
  assert.notEqual(data.options[0].result.path, data.options[1].result.path);
  assert.notEqual(data.options[0].result.sha256, data.options[1].result.sha256);
  assert.deepEqual(evidenceTotals(data), { generations: 2, nominal: 4, actual: 4, automaticRetries: 0 });
});

test('every included source/result file has the actual approved SHA256; no changed or invented output', async () => {
  const data = validateManifest(copy());
  const assets = [data.source.asset, ...data.options.flatMap(option => [option.input, option.result])];
  assert.equal(assets.length, 5);
  for (const asset of assets) {
    assert.equal(createHash('sha256').update(await readFile(path.join(app, asset.path))).digest('hex'), asset.sha256);
    assert.equal(asset.sha256, ASSET_HASHES[asset.path]);
  }
});

test('a foreign/signed URL or an altered actual-output hash fails closed', () => {
  let data = copy(); data.options[0].result.path = 'https://evil.invalid/result.jpg?X-Amz-Signature=example';
  assert.throws(() => validateManifest(data), /MANIFEST_ASSET_REJECTED/);
  data = copy(); data.options[0].result.sha256 = 'a'.repeat(64);
  assert.throws(() => validateManifest(data), /MANIFEST_ASSET_REJECTED/);
});

test('B cannot reuse A or swap its approved garment reference', () => {
  let data = copy(); data.options[1].result = data.options[0].result;
  assert.throws(() => validateManifest(data), /MANIFEST_ASSET_REJECTED/);
  data = copy(); data.options[1].input = data.options[0].input;
  assert.throws(() => validateManifest(data), /MANIFEST_ASSET_REJECTED/);
});

test('unexpected secret/raw-response fields, invented counts and missing actual usage are rejected', () => {
  let data = copy(); data.apiKey = 'NOT_A_REAL_KEY';
  assert.throws(() => validateManifest(data), /MANIFEST_FIELDS_REJECTED/);
  data = copy(); data.options[0].request.generationPosts = 2;
  assert.throws(() => validateManifest(data), /MANIFEST_REQUEST_REJECTED/);
  data = copy(); data.options[0].units.actual = null;
  assert.throws(() => validateManifest(data), /MANIFEST_UNITS_REJECTED/);
});

test('repeated choice/view/reset actions alter local state only and preserve immutable evidence', () => {
  const data = validateManifest(copy()); const before = JSON.stringify(data);
  let state = initialState();
  for (let i = 0; i < 50; i += 1) {
    state = selectOption(state, 'look-b'); state = setView(state, 'result');
    assert.equal(selectedEvidence(data, state).hasResult, true);
    assert.equal(viewerPresentation(data, state).right.path, data.options[1].result.path);
    state = selectOption(state, 'look-a'); state = setView(state, 'original');
    assert.equal(selectedEvidence(data, state).hasResult, true);
    state = resetView();
  }
  assert.deepEqual(state, initialState());
  assert.equal(JSON.stringify(data), before);
});

test('manifest retrieval has one same-origin read and no account credentials or redirect following', async () => {
  let count = 0;
  const data = await loadManifest(async (url, options) => {
    count += 1; assert.equal(url, './demo-manifest.json');
    assert.equal(options.mode, 'same-origin'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => copy() };
  });
  assert.equal(count, 1); assert.equal(data.phase, 'two-results');
});

test('static route serves a working document with restrictive CSP and no active-generation form', async () => {
  const result = await localRequest('/');
  assert.equal(result.status, 200); assert.equal(result.headers['Content-Security-Policy'], CSP);
  assert.match(result.body.toString(), /Two generated looks/); assert.match(result.body.toString(), /Recorded demo/);
  assert.doesNotMatch(result.body.toString(), /Not generated|Phase 01|One result verified/);
  assert.doesNotMatch(result.body.toString(), /<form\b/i);
  assert.match(result.headers['Content-Security-Policy'], /form-action 'none'/);
});

test('two-look view pairs actual A and B, while before/after shares the unchanged synthetic source', () => {
  const data = validateManifest(copy());
  const presentation = viewerPresentation(data, initialState());
  assert.equal(presentation.left.path, data.options[0].result.path);
  assert.equal(presentation.right.path, data.options[1].result.path);
  assert.equal(presentation.showLeft, true); assert.equal(presentation.showRight, true);
  for (const option of data.options) {
    const state = setView(selectOption(initialState(), option.id), 'compare');
    const pair = viewerPresentation(data, state);
    assert.equal(pair.left.path, data.source.asset.path); assert.equal(pair.right.path, option.result.path);
    assert.match(pair.right.alt, new RegExp(option.label.toLowerCase()));
  }
});

test('single-image modes show only the requested original or selected real output', () => {
  const data = validateManifest(copy());
  const b = selectOption(initialState(), 'look-b');
  const original = viewerPresentation(data, setView(b, 'original'));
  assert.equal(original.showLeft, true); assert.equal(original.showRight, false);
  assert.equal(original.left.path, data.source.asset.path);
  const result = viewerPresentation(data, setView(b, 'result'));
  assert.equal(result.showLeft, false); assert.equal(result.showRight, true);
  assert.equal(result.right.path, data.options[1].result.path);
});

test('per-run counters and observation times retain the different A and B execution records', () => {
  const data = validateManifest(copy());
  assert.equal(data.options[0].request.statusGets, 2);
  assert.equal(data.options[1].request.statusGets, 1);
  assert.equal(data.options[0].result.recordedAtUTC, '2026-10-30T17:26:15.067595Z');
  assert.equal(data.options[1].result.recordedAtUTC, '2026-10-30T18:22:12.361748Z');
  assert.equal(data.options[1].units.verifiedAtUTC, '2026-10-30T18:22:59.309313Z');
  data.options[1].request.statusGets = 2;
  assert.throws(() => validateManifest(data), /MANIFEST_REQUEST_REJECTED/);
});

test('invented zero debit, account-balance-derived measurement or altered observation time fails closed', () => {
  let data = copy(); data.options[1].units.actual = 0;
  assert.throws(() => validateManifest(data), /MANIFEST_UNITS_REJECTED/);
  data = copy(); data.options[1].units.measurement = 'balance_delta';
  assert.throws(() => validateManifest(data), /MANIFEST_UNITS_REJECTED/);
  data = copy(); data.options[1].result.recordedAtUTC = '2026-10-30T18:21:44Z';
  assert.throws(() => validateManifest(data), /MANIFEST_TIME_REJECTED/);
});

test('invalid selections, view names, missing results and injected labels do not become successes', () => {
  const data = validateManifest(copy());
  assert.throws(() => selectOption(initialState(), 'look-c'), /OPTION_REJECTED/);
  assert.throws(() => setView(initialState(), 'generate'), /VIEW_REJECTED/);
  assert.throws(() => viewerPresentation(data, { selectedId: 'look-a', view: 'unknown' }), /VIEW_REJECTED/);
  let bad = copy(); bad.options[1].result = null;
  assert.throws(() => validateManifest(bad), /MANIFEST_FIELDS_REJECTED/);
  bad = copy(); bad.options[0].label = '<img onerror=alert(1)>';
  assert.throws(() => validateManifest(bad), /MANIFEST_RESULT_REJECTED/);
});

test('manifest failures and extra nested raw provider fields are rejected without a fallback output', async () => {
  await assert.rejects(loadManifest(async () => ({ ok: false })), /MANIFEST_LOAD_FAILED/);
  const data = copy(); data.options[1].result.providerRaw = { task_id: 'EXAMPLE_ONLY' };
  await assert.rejects(loadManifest(async () => ({ ok: true, json: async () => data })), /MANIFEST_FIELDS_REJECTED/);
});

test('both immutable output assets are served as JPEG while mutation and unknown sibling assets are refused', async () => {
  for (const option of manifest.options) {
    const response = await localRequest('/' + option.result.path);
    assert.equal(response.status, 200);
    assert.match(response.headers['Content-Type'], /^image\/jpeg/);
    assert.equal(createHash('sha256').update(response.body).digest('hex'), option.result.sha256);
    assert.equal((await localRequest('/' + option.result.path, 'POST')).status, 405);
  }
  assert.equal((await localRequest('/assets/unknown-result.jpg')).status, 404);
});

test('actual client rendering and repeated controls make only one local manifest read and use each matching result', async () => {
  const html = await readFile(path.join(app, 'index.html'), 'utf8');
  const elements = new Map();
  const make = () => ({ hidden: false, dataset: {}, textContent: '', attributes: {}, listeners: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, callback) { this.listeners[event] = callback; },
  });
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = make(); element.hidden = /\shidden(?:\s|>)/.test(match[0]);
    elements.set(match[1], element);
  }
  const options = ['look-a', 'look-b'].map(id => ({ ...make(), dataset: { option: id } }));
  const views = ['looks', 'compare', 'original', 'result'].map(view => ({ ...make(), dataset: { view } }));
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  let readCount = 0;
  globalThis.document = { getElementById: id => elements.get(id), querySelectorAll: selector => selector === '[data-option]' ? options : views };
  globalThis.fetch = async (url, options) => {
    readCount += 1; assert.equal(url, './demo-manifest.json'); assert.equal(options.credentials, 'omit');
    return { ok: true, json: async () => copy() };
  };
  try {
    const client = await import('../app/app.mjs?offline-two-results'); await client.ready;
    assert.equal(elements.get('load-error').hidden, true);
    assert.equal(elements.get('studio').hidden, false); assert.equal(elements.get('provenance').hidden, false);
    assert.equal(elements.get('original-image').src, manifest.options[0].result.path);
    assert.equal(elements.get('result-image').src, manifest.options[1].result.path);
    assert.equal(elements.get('actual-value').textContent, '4');
    assert.equal(elements.get('run-b-requests').textContent, '1 generation · 1 status check · no automatic retry');
    for (let i = 0; i < 50; i += 1) {
      options[1].listeners.click(); views[1].listeners.click();
      assert.equal(elements.get('original-image').src, manifest.source.asset.path);
      assert.equal(elements.get('result-image').src, manifest.options[1].result.path);
      assert.match(elements.get('result-image').alt, /rust shirt/);
      assert.match(elements.get('usage-date').textContent, /18:22/);
      views[2].listeners.click(); assert.equal(elements.get('result-figure').hidden, true);
      views[3].listeners.click(); assert.equal(elements.get('original-figure').hidden, true);
      elements.get('reset-view').listeners.click();
      assert.equal(elements.get('original-image').src, manifest.options[0].result.path);
      assert.equal(elements.get('result-image').src, manifest.options[1].result.path);
    }
    assert.equal(readCount, 1); assert.equal(options[0].attributes['aria-pressed'], 'true');
    assert.equal(views[0].attributes['aria-pressed'], 'true');
    assert.match(elements.get('interaction-status').textContent, /no request was sent/);
  } finally { globalThis.document = previousDocument; globalThis.fetch = previousFetch; }
});

test('public server cannot process, upload, mutate or serve private/operator paths', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const result = await localRequest('/generate', method); assert.equal(result.status, 405);
  }
  for (const url of ['/runtime/one-shot-probe.json', '/.env.local', '/../runtime/one-shot-probe.json',
    '/%2e%2e/.env.local', '/assets/%2e%2e/%2e%2e/.env.local', '/tools/one-shot-probe.mjs', '/api/generate']) {
    assert.equal((await localRequest(url)).status, 404, url);
  }
});

test('public package contains no environment/runtime files, external executable imports or unsafe DOM insertion', async () => {
  const names = await readdir(app);
  assert.ok(names.every(name => !name.startsWith('.env') && name !== 'runtime'));
  const [client, model, css, json] = await Promise.all(['app.mjs', 'manifest.mjs', 'styles.css', 'demo-manifest.json'].map(name => readFile(path.join(app, name), 'utf8')));
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|XMLHttpRequest|sendBeacon|localStorage|process\.env/);
  assert.doesNotMatch(client + model, /https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(/);
  assert.doesNotMatch(json, /Bearer|X-Amz-|task_id|file_id|api[_-]?key|runtime\//i);
});
