// Public evidence only. No provider credential, request adapter or spending route.
export const ASSET_HASHES = Object.freeze({
  'assets/synthetic-adult-model.png': '4899e37d3c02ff680852747e1608cfe97eecc7e861fdc29ad566ec648dedb98d',
  'assets/garment-a-forest-crewneck.png': 'ed786800cfeedda7f0bffd83fe0fdedf1211dfe0e7032f169ff239c7a019af6b',
  'assets/garment-b-rust-shirt.png': 'e544259e22d76109b689f31a2512e6ec0ec57f99476232f74a85a44efc602b10',
  'assets/youcam-garment-a-result.jpg': '0cdcb53e100c68d7e12b614de0a15f6f4db33cd4c8d44cd0b807effa12bd3156',
  'assets/youcam-garment-b-result.jpg': 'e2fc41a242fdd8962d9758676e4ccca96f02c9427c630d9e28933e7723150e62',
});
const RUNS = Object.freeze([
  { id: 'look-a', label: 'Forest crewneck', color: 'Forest green',
    input: 'assets/garment-a-forest-crewneck.png', result: 'assets/youcam-garment-a-result.jpg',
    recordedAtUTC: '2026-10-30T17:26:15.067595Z', verifiedAtUTC: '2026-10-30T17:27:29.456376Z', statusGets: 2 },
  { id: 'look-b', label: 'Rust shirt', color: 'Rust',
    input: 'assets/garment-b-rust-shirt.png', result: 'assets/youcam-garment-b-result.jpg',
    recordedAtUTC: '2026-10-30T18:22:12.361748Z', verifiedAtUTC: '2026-10-30T18:22:59.309313Z', statusGets: 1 },
]);
const VIEWS = Object.freeze(['looks', 'compare', 'original', 'result']);
const fail = code => { throw new Error(code); };
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(value, key))) fail('MANIFEST_FIELDS_REJECTED');
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail('MANIFEST_TIME_REJECTED');
}
function asset(value, expected) {
  keys(value, ['path', 'sha256']);
  if (value.path !== expected || value.sha256 !== ASSET_HASHES[expected]) fail('MANIFEST_ASSET_REJECTED');
}
export function validateManifest(value) {
  keys(value, ['schemaVersion', 'project', 'phase', 'recordedAtUTC', 'source', 'options']);
  if (value.schemaVersion !== 2 || value.project !== 'StyleProof' || value.phase !== 'two-results') fail('MANIFEST_PHASE_REJECTED');
  timestamp(value.recordedAtUTC);
  if (value.recordedAtUTC !== RUNS[1].verifiedAtUTC) fail('MANIFEST_TIME_REJECTED');
  keys(value.source, ['id', 'label', 'synthetic', 'asset']);
  if (value.source.id !== 'synthetic-model' || value.source.label !== 'Original synthetic model'
    || value.source.synthetic !== true) fail('MANIFEST_SOURCE_REJECTED');
  asset(value.source.asset, 'assets/synthetic-adult-model.png');
  if (!Array.isArray(value.options) || value.options.length !== 2) fail('MANIFEST_OPTIONS_REJECTED');
  value.options.forEach((option, index) => {
    const recorded = RUNS[index];
    keys(option, ['id', 'label', 'color', 'status', 'input', 'result', 'request', 'units']);
    if (option.id !== recorded.id || option.label !== recorded.label || option.color !== recorded.color
      || option.status !== 'recorded_success') fail('MANIFEST_RESULT_REJECTED');
    asset(option.input, recorded.input);
    keys(option.result, ['path', 'sha256', 'recordedAtUTC', 'provider', 'version']);
    asset({ path: option.result.path, sha256: option.result.sha256 }, recorded.result);
    timestamp(option.result.recordedAtUTC);
    if (option.result.recordedAtUTC !== recorded.recordedAtUTC) fail('MANIFEST_TIME_REJECTED');
    if (option.result.provider !== 'YouCam API' || option.result.version !== 'cloth-v4') fail('MANIFEST_PROVIDER_REJECTED');
    keys(option.request, ['metadataPosts', 'uploadPuts', 'generationPosts', 'statusGets', 'automaticRetries']);
    if (option.request.metadataPosts !== 1 || option.request.uploadPuts !== 2 || option.request.generationPosts !== 1
      || option.request.statusGets !== recorded.statusGets || option.request.automaticRetries !== 0) fail('MANIFEST_REQUEST_REJECTED');
    keys(option.units, ['nominal', 'actual', 'measurement', 'verifiedAtUTC']);
    if (option.units.nominal !== 2 || option.units.actual !== 2 || option.units.measurement !== 'provider_usage_ledger') fail('MANIFEST_UNITS_REJECTED');
    timestamp(option.units.verifiedAtUTC);
    if (option.units.verifiedAtUTC !== recorded.verifiedAtUTC) fail('MANIFEST_TIME_REJECTED');
  });
  // Return a fresh copy so UI state cannot alter the evidence object held by the caller.
  return JSON.parse(JSON.stringify(value));
}
export async function loadManifest(fetchImpl = fetch) {
  const response = await fetchImpl('./demo-manifest.json', { credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin' });
  if (!response.ok) fail('MANIFEST_LOAD_FAILED');
  return validateManifest(await response.json());
}
export const initialState = () => ({ selectedId: 'look-a', view: 'looks' });
export function selectOption(state, id) {
  if (!['look-a', 'look-b'].includes(id)) fail('OPTION_REJECTED');
  return { ...state, selectedId: id };
}
export function setView(state, view) {
  if (!VIEWS.includes(view)) fail('VIEW_REJECTED');
  return { ...state, view };
}
export const resetView = () => initialState();
export function evidenceTotals(manifest) {
  return manifest.options.reduce((total, option) => ({
    generations: total.generations + option.request.generationPosts,
    nominal: total.nominal + option.units.nominal,
    actual: total.actual + option.units.actual,
    automaticRetries: total.automaticRetries + option.request.automaticRetries,
  }), { generations: 0, nominal: 0, actual: 0, automaticRetries: 0 });
}
export function selectedEvidence(manifest, state) {
  const selected = manifest.options.find(option => option.id === state.selectedId);
  if (!selected) fail('OPTION_REJECTED');
  return { selected, hasResult: selected.status === 'recorded_success' && selected.result !== null,
    generatedCount: manifest.options.filter(option => option.status === 'recorded_success').length };
}
export function viewerPresentation(manifest, state) {
  if (!VIEWS.includes(state.view)) fail('VIEW_REJECTED');
  const { selected } = selectedEvidence(manifest, state);
  const output = option => ({
    path: option.result.path, label: option.label, kind: 'YouCam result', optionId: option.id,
    alt: `Real recorded YouCam Clothes V4 output: synthetic adult model wearing the ${option.label.toLowerCase()}`,
    caption: `${option.label} · Saved real output`,
  });
  const original = { path: manifest.source.asset.path, label: 'Original', kind: 'Synthetic source', optionId: null,
    alt: 'Original fully clothed synthetic adult model, before either clothing try-on', caption: 'Synthetic source · Unchanged input' };
  const [a, b] = manifest.options;
  return {
    title: state.view === 'looks' ? 'Two looks, one original' : selected.label,
    left: state.view === 'looks' ? output(a) : original,
    right: state.view === 'looks' ? output(b) : output(selected),
    showLeft: state.view !== 'result', showRight: state.view !== 'original',
  };
}
