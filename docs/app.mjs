import { evidenceTotals, initialState, loadManifest, resetView, selectedEvidence, selectOption, setView, viewerPresentation } from './manifest.mjs';

const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const utcDate = value => new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}).format(new Date(value)).replace(' at ', ', ') + ' UTC';
let state = initialState();
let manifest;

function renderFigure(prefix, figure, shown) {
  byId(`${prefix}-figure`).hidden = !shown;
  const image = byId(`${prefix}-image`);
  image.src = figure.path;
  image.alt = figure.alt;
  text(`${prefix}-tag`, figure.kind === 'YouCam result' ? `${figure.label} · YouCam result` : figure.label);
  text(`${prefix}-caption`, figure.caption);
  byId(`${prefix}-figure`).dataset.selected = String(figure.optionId === state.selectedId);
}

function render() {
  const { selected, generatedCount } = selectedEvidence(manifest, state);
  const presentation = viewerPresentation(manifest, state);
  text('selected-title', presentation.title);
  text('selected-hint', `Selected look: ${selected.label}`);
  text('generated-count', `${String(generatedCount).padStart(2, '0')} / 02`);
  document.querySelectorAll('[data-option]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.option === state.selectedId)));
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
  byId('image-stage').dataset.mode = state.view;
  renderFigure('original', presentation.left, presentation.showLeft);
  renderFigure('result', presentation.right, presentation.showRight);
  text('viewer-status', state.view === 'looks' ? 'Two saved real outputs · Same synthetic source' : `Saved real result · ${utcDate(selected.result.recordedAtUTC)}`);
  text('evidence-option', `${selected.label} · Recorded success`);
  text('evidence-provider', `${selected.result.provider} · ${selected.result.version}`);
  text('evidence-date', `${utcDate(selected.result.recordedAtUTC)} · local result observation`);
  text('evidence-requests', `${selected.request.metadataPosts} file registration · ${selected.request.uploadPuts} uploads · ${selected.request.generationPosts} generation · ${selected.request.statusGets} status check${selected.request.statusGets === 1 ? '' : 's'} · 0 automatic retries`);
  text('evidence-units', `${selected.units.nominal} nominal units · ${selected.units.actual} actual ledger debit`);
  text('usage-date', `${utcDate(selected.units.verifiedAtUTC)} · provider usage ledger`);
  text('source-hash', manifest.source.asset.sha256);
  text('input-hash', selected.input.sha256);
  text('result-hash', selected.result.sha256);
}

async function start() {
  try {
    manifest = await loadManifest();
    const totals = evidenceTotals(manifest);
    manifest.options.forEach((option, index) => {
      const letter = index === 0 ? 'a' : 'b';
      byId(`garment-${letter}`).src = option.input.path;
      text(`run-${letter}-date`, `Result saved ${utcDate(option.result.recordedAtUTC)}`);
      text(`run-${letter}-units`, `${option.units.nominal} nominal · ${option.units.actual} actual units`);
      text(`run-${letter}-verified`, `Ledger checked ${utcDate(option.units.verifiedAtUTC)}`);
      text(`run-${letter}-requests`, `1 generation · ${option.request.statusGets} status check${option.request.statusGets === 1 ? '' : 's'} · no automatic retry`);
    });
    text('generation-total', String(totals.generations).padStart(2, '0'));
    text('nominal-value', String(totals.nominal));
    text('actual-value', String(totals.actual));
    render();
    document.querySelectorAll('[data-option]').forEach(button => button.addEventListener('click', () => {
      state = selectOption(state, button.dataset.option); render();
      text('interaction-status', 'Selected look and evidence changed locally. No photos sent. No new API request.');
    }));
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
      state = setView(state, button.dataset.view); render();
      text('interaction-status', 'View changed locally. No new generation or units used.');
    }));
    byId('reset-view').addEventListener('click', () => {
      state = resetView(); render();
      text('interaction-status', 'View reset. Saved provider results are unchanged; no request was sent.');
    });
    byId('studio').hidden = false;
    byId('provenance').hidden = false;
  } catch {
    byId('studio').hidden = true;
    byId('provenance').hidden = true;
    byId('load-error').hidden = false;
  } finally {
    byId('loading').hidden = true;
  }
}
export const ready = start();
