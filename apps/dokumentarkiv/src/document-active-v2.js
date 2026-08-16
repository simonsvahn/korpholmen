import { createActiveAppBundle } from '../../../packages/core/active-app-bundle.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'sv', { numeric: true });
const timeLabel = time => time?.original_text || time?.start_min || time?.start_max || 'Odaterat';
const VIEWS = new Set(['overview', 'reader', 'tracks', 'connections', 'places', 'work', 'question']);

const cardMetric = (value, label) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;

export class DocumentActiveV2 {
  constructor({ store, view, statusNode, imageLoader } = {}) {
    this.bundle = createActiveAppBundle({ store, cacheKey: 'documents-active-v2', sources: {
      documents: { pointerPath: '/dokumentarkiv-generation2/active.json', app: 'dokumentarkiv', requiredCollections: ['documents', 'document_parts', 'document_categories', 'document_types', 'document_links'] },
    } });
    this.view = view;
    this.statusNode = statusNode;
    this.imageLoader = imageLoader;
    this.search = '';
    this.category = '';
    this.selectedId = '';
    this.mode = 'overview';
  }

  async init() {
    await this.bundle.init();
    if (typeof location !== 'undefined') {
      const requested = new URLSearchParams(location.search).get('document');
      if (requested) { this.selectedId = requested; this.mode = 'reader'; }
    }
    return this;
  }
  hasData() { return this.bundle.hasData('documents'); }
  async sync(transport) { return this.bundle.sync(transport); }
  list(name) { return this.bundle.list('documents', name); }

  configureShell() {
    document.documentElement.dataset.documentV2 = 'true';
    const navigation = document.querySelector('#view-tabs');
    if (navigation) navigation.hidden = false;
    const band = document.querySelector('#search-band');
    band.innerHTML = `<label class="sokruta"><span>⌕</span><input id="v2-document-search" type="search" placeholder="Sök i titel, avskrift eller länk …"></label><label class="typfilter"><span>Huvudkategori</span><select id="v2-document-category"><option value="">Alla</option></select></label><output id="v2-document-count"></output>`;
    band.querySelector('#v2-document-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    band.querySelector('#v2-document-category').addEventListener('change', event => { this.category = event.target.value; this.render(); });
    this.view.addEventListener('click', event => {
      const open = event.target.closest('[data-v2-document]');
      if (open) this.open(open.dataset.v2Document);
      if (event.target.closest('[data-v2-document-back]')) this.close();
      const image = event.target.closest('[data-v2-document-image]');
      if (image) this.showImage(image);
      const category = event.target.closest('[data-v2-document-category]')?.dataset.v2DocumentCategory;
      if (category !== undefined) {
        this.category = category;
        const select = document.querySelector('#v2-document-category');
        if (select) select.value = category;
        this.setView('reader');
      }
    });
  }

  setView(mode) {
    this.selectedId = '';
    this.mode = VIEWS.has(mode) ? mode : 'overview';
    this.updateUrl('');
    this.render();
  }

  categories() { return new Map(this.list('document_categories').map(row => [row.id, row.display_name])); }
  types() { return new Map(this.list('document_types').map(row => [row.id, row.display_name])); }
  partsFor(document) { const ids = new Set(document.part_ids || []); return this.list('document_parts').filter(row => ids.has(row.id) || row.document_ref?.entity_id === document.id).sort((a, b) => a.order - b.order); }
  linksFor(document) { return this.list('document_links').filter(row => row.document_ref?.entity_id === document.id || row.source_document_ref?.entity_id === document.id || row.document_id === document.id); }
  searchText(document) { return normalize([document.title, timeLabel(document.time), ...this.partsFor(document).map(part => part.transcription?.text), ...this.linksFor(document).flatMap(link => link.source_labels || [])].join(' ')); }

  visible() {
    const needle = normalize(this.search);
    return this.list('documents').filter(document => (!this.category || document.category_id === this.category) && (!needle || this.searchText(document).includes(needle)))
      .sort((a, b) => String(timeLabel(b.time)).localeCompare(String(timeLabel(a.time)), 'sv') || compare(a.title, b.title));
  }

  populateFilters() {
    const select = document.querySelector('#v2-document-category');
    if (select && select.options.length === 1) select.insertAdjacentHTML('beforeend', [...this.categories()].map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join(''));
    if (select) select.value = this.category;
  }

  updateChrome(documents) {
    document.querySelectorAll('#view-tabs [data-view]').forEach(button => {
      const active = button.dataset.view === this.mode;
      button.classList.toggle('aktiv', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const total = document.querySelector('#document-total'); if (total) total.textContent = String(this.list('documents').length);
    const years = this.list('documents').map(row => row.time?.start_min).filter(Number.isFinite);
    const range = document.querySelector('#year-range'); if (range) range.textContent = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—';
    const count = document.querySelector('#v2-document-count'); if (count) count.textContent = `${documents.length} av ${this.list('documents').length}`;
  }

  documentButton(document) {
    const categories = this.categories();
    const parts = this.partsFor(document);
    return `<button type="button" data-v2-document="${escapeHtml(document.id)}"><time>${escapeHtml(timeLabel(document.time))}</time><span><b>${escapeHtml(document.title)}</b><small>${escapeHtml(categories.get(document.category_id) || document.category_id || 'Övrigt')} · ${parts.length} ${parts.length === 1 ? 'del' : 'delar'} · ${this.linksFor(document).length} kopplingar</small></span></button>`;
  }

  documentList(documents, emptyTitle = 'Inga dokument') {
    return documents.length ? `<section class="v2-document-list">${documents.map(row => this.documentButton(row)).join('')}</section>` : `<section class="tomtresultat"><h2>${escapeHtml(emptyTitle)}</h2><p>Anslut Dropbox eller ändra filtren.</p></section>`;
  }

  renderOverview(documents) {
    const categories = this.categories();
    const links = this.list('document_links');
    const uncertain = this.list('document_parts').filter(part => part.has_uncertainty).length;
    const grouped = [...categories].map(([id, name]) => ({ id, name, count: this.list('documents').filter(row => row.category_id === id).length })).filter(row => row.count);
    this.view.innerHTML = `<section class="v2-document-overview"><div class="v2-document-hero"><p class="eyebrow">Aktiv V2-master</p><h2>Arkivet i ett svep</h2><p>Dokumentpaket samlar huvudhandling och bilagor. Sökningen läser både titlar, avskrifter och godkända kopplingar.</p><div class="v2-document-metrics">${cardMetric(this.list('documents').length, 'dokument')}${cardMetric(this.list('document_parts').length, 'delar')}${cardMetric(links.length, 'kopplingar')}${cardMetric(uncertain, 'delar med läsosäkerhet')}</div></div><div class="v2-document-categories">${grouped.map(row => `<button type="button" data-v2-document-category="${escapeHtml(row.id)}"><strong>${escapeHtml(row.name)}</strong><span>${row.count} dokument</span></button>`).join('')}</div><div class="v2-document-latest"><header><h3>Senaste dokumenten</h3><button type="button" data-v2-document-category="">Visa alla →</button></header>${this.documentList(documents.slice(0, 8))}</div></section>`;
  }

  renderTracks(documents) {
    const multiPart = documents.filter(document => this.partsFor(document).length > 1);
    const events = new Map(this.list('document_events').map(row => [row.id, row]));
    const eventLinks = this.list('document_links').filter(link => link.target_ref?.entity_type === 'event');
    const eventCards = [...new Set(eventLinks.map(link => link.target_ref.entity_id))].map(id => {
      const event = events.get(id);
      const linkedDocuments = documents.filter(document => this.linksFor(document).some(link => link.target_ref?.entity_id === id));
      return { id, name: event?.display_name || eventLinks.find(link => link.target_ref.entity_id === id)?.source_labels?.[0] || id, documents: linkedDocuments };
    }).filter(row => row.documents.length);
    this.view.innerHTML = `<section class="v2-document-section"><header><h2>Berättelsespår</h2><p>Här visas verkligt sammanhållna dokumentpaket och uttryckliga händelselänkar. Inga automatiska antaganden läggs till.</p></header>${eventCards.length ? `<div class="v2-document-groups">${eventCards.map(group => `<article><h3>${escapeHtml(group.name)}</h3><div class="v2-document-list">${group.documents.map(row => this.documentButton(row)).join('')}</div></article>`).join('')}</div>` : ''}<h3>Dokument med flera delar</h3>${this.documentList(multiPart, 'Inga flerdelade dokument med valda filter')}</section>`;
  }

  linkLabel(link) { return (link.source_labels || []).join(' · ') || link.target_ref?.entity_id || 'Länk'; }

  targetLink(link) {
    const label = escapeHtml(this.linkLabel(link));
    const target = link.target_ref;
    if (!target?.entity_id) return label;
    if (target.master === 'people' && target.entity_type === 'person') return `<a href="../personer-familjer/?person=${encodeURIComponent(target.entity_id)}">${label}</a>`;
    if (target.master === 'batregister' && target.entity_type === 'boat') return `<a href="../batregister/?boat=${encodeURIComponent(target.entity_id)}">${label}</a>`;
    if (target.master === 'fastigheter' || target.entity_type === 'property') return `<a href="../fastigheter/?property=${encodeURIComponent(target.entity_id)}">${label}</a>`;
    if (target.master === 'kartdata' || target.entity_type === 'place') return `<a href="../kartdata/?place=${encodeURIComponent(target.entity_id)}">${label}</a>`;
    return label;
  }

  renderConnections(documents) {
    const visibleIds = new Set(documents.map(row => row.id));
    const groups = new Map();
    this.list('document_links').filter(link => visibleIds.has(link.document_ref?.entity_id || link.source_document_ref?.entity_id || link.document_id)).forEach(link => {
      const type = link.target_ref?.entity_type || 'övrigt';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(link);
    });
    const labels = { person: 'Personer', boat: 'Båtar', organization: 'Organisationer och kommittéer', award: 'Utmärkelser', event: 'Händelser', family_unit: 'Familjer', fund: 'Fonder', place: 'Platser', property: 'Fastigheter', övrigt: 'Övrigt' };
    this.view.innerHTML = groups.size ? `<section class="v2-document-section"><header><h2>Samband</h2><p>Godkända, strukturerade länkar från dokumenten till övriga mastrar.</p></header><div class="v2-connection-groups">${[...groups].sort((a, b) => compare(labels[a[0]] || a[0], labels[b[0]] || b[0])).map(([type, links]) => `<article><header><h3>${escapeHtml(labels[type] || type)}</h3><span>${links.length} kopplingar</span></header><div>${links.sort((a, b) => compare(this.linkLabel(a), this.linkLabel(b))).map(link => `<span>${this.targetLink(link)}<small>${(link.roles || []).map(escapeHtml).join(', ')}</small></span>`).join('')}</div></article>`).join('')}</div></section>` : '<section class="tomtresultat"><h2>Inga kopplingar med valda filter</h2></section>';
  }

  renderPlaces(documents) {
    const visibleIds = new Set(documents.map(row => row.id));
    const links = this.list('document_links').filter(link => visibleIds.has(link.document_ref?.entity_id || link.source_document_ref?.entity_id || link.document_id) && ['place', 'property'].includes(link.target_ref?.entity_type));
    this.view.innerHTML = links.length ? `<section class="v2-document-section"><header><h2>Platser</h2><p>Dokument som uttryckligen är kopplade till en plats eller fastighet.</p></header><div class="v2-place-links">${links.map(link => { const document = this.list('documents').find(row => row.id === (link.document_ref?.entity_id || link.source_document_ref?.entity_id || link.document_id)); return `<article><h3>${this.targetLink(link)}</h3>${document ? `<div class="v2-document-list">${this.documentButton(document)}</div>` : ''}</article>`; }).join('')}</div></section>` : '<section class="tomtresultat"><h2>Inga uttryckliga platskopplingar</h2><p>Övriga dokument kan fortfarande nämna platser i avskriften.</p></section>';
  }

  renderWork(documents) {
    const rows = documents.map(document => {
      const parts = this.partsFor(document);
      const reasons = [];
      if (parts.some(part => part.has_uncertainty)) reasons.push('svårläst avskrift');
      if (parts.some(part => !part.transcription?.text)) reasons.push('avskrift saknas');
      if (!this.linksFor(document).length) reasons.push('inga godkända kopplingar');
      return { document, reasons };
    }).filter(row => row.reasons.length);
    this.view.innerHTML = rows.length ? `<section class="v2-document-section"><header><h2>Arbetskö</h2><p>Automatiskt härledda uppmärksamhetspunkter. Inget ändras genom att du öppnar dem här.</p></header><div class="v2-work-list">${rows.map(row => `<article><div class="v2-document-list">${this.documentButton(row.document)}</div><p>${row.reasons.map(reason => `<span>${escapeHtml(reason)}</span>`).join('')}</p></article>`).join('')}</div></section>` : '<section class="tomtresultat"><h2>Ingen automatisk arbetskö</h2></section>';
  }

  snippet(document) {
    const needle = normalize(this.search);
    const text = this.partsFor(document).map(part => part.transcription?.text || '').join('\n');
    if (!needle || !text) return '';
    const normalized = normalize(text);
    const index = normalized.indexOf(needle);
    if (index < 0) return '';
    const start = Math.max(0, index - 110);
    const end = Math.min(text.length, index + this.search.length + 170);
    return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
  }

  renderQuestion(documents) {
    if (!this.search.trim()) {
      this.view.innerHTML = '<section class="v2-question-empty"><h2>Sök i hela arkivet</h2><p>Skriv ett namn, en båt, en plats eller ett ord i sökrutan. Då visas varje dokument tillsammans med den första relevanta textträffen.</p></section>';
      return;
    }
    this.view.innerHTML = documents.length ? `<section class="v2-document-section"><header><h2>Träffar på ”${escapeHtml(this.search)}”</h2><p>${documents.length} dokument.</p></header><div class="v2-question-results">${documents.map(document => `<article><div class="v2-document-list">${this.documentButton(document)}</div>${this.snippet(document) ? `<blockquote>${escapeHtml(this.snippet(document))}</blockquote>` : ''}</article>`).join('')}</div></section>` : '<section class="tomtresultat"><h2>Inga textträffar</h2></section>';
  }

  render() {
    this.populateFilters();
    const documents = this.visible();
    this.updateChrome(documents);
    if (this.selectedId) return this.open(this.selectedId, { updateUrl: false });
    if (this.mode === 'overview') this.renderOverview(documents);
    else if (this.mode === 'reader') this.view.innerHTML = this.documentList(documents);
    else if (this.mode === 'tracks') this.renderTracks(documents);
    else if (this.mode === 'connections') this.renderConnections(documents);
    else if (this.mode === 'places') this.renderPlaces(documents);
    else if (this.mode === 'work') this.renderWork(documents);
    else this.renderQuestion(documents);
  }

  updateUrl(id) {
    if (typeof location === 'undefined') return;
    const url = new URL(location.href);
    if (id) url.searchParams.set('document', id); else url.searchParams.delete('document');
    history.replaceState(null, '', url);
  }

  open(id, { updateUrl = true } = {}) {
    const documentRow = this.list('documents').find(row => row.id === id);
    if (!documentRow) return;
    this.selectedId = id;
    this.mode = 'reader';
    this.updateChrome(this.visible());
    const types = this.types();
    const links = this.linksFor(documentRow);
    this.view.innerHTML = `<article class="v2-document-reader"><button type="button" data-v2-document-back>← Alla dokument</button><header><p>${escapeHtml(timeLabel(documentRow.time))}</p><h2>${escapeHtml(documentRow.title)}</h2><small>${(documentRow.type_ids || []).map(type => types.get(type) || type).map(escapeHtml).join(' · ')}</small></header>${links.length ? `<section class="v2-document-links"><h3>Kopplingar</h3>${links.map(link => `<span>${this.targetLink(link)}${link.roles?.length ? `<small>${link.roles.map(escapeHtml).join(', ')}</small>` : ''}</span>`).join('')}</section>` : ''}${this.partsFor(documentRow).map((part, partIndex) => { const files = part.sources?.files || []; return `<section class="v2-document-part"><header><h3>${escapeHtml(part.title || `Del ${partIndex + 1}`)}</h3><span>${files.length} ${files.length === 1 ? 'bild' : 'bilder'}</span></header>${files.length ? `<div class="v2-document-images">${files.map((file, imageIndex) => `<button type="button" data-v2-document-image="${partIndex}:${imageIndex}">Visa bild ${imageIndex + 1}</button>`).join('')}</div><div data-v2-document-image-stage="${partIndex}"></div>` : ''}<div class="v2-transcription">${escapeHtml(part.transcription?.text || 'Avskrift saknas.').replaceAll('\n\n', '</p><p>').replaceAll('\n', '<br>')}</div></section>`; }).join('')}</article>`;
    if (updateUrl) this.updateUrl(id);
  }

  close() { this.selectedId = ''; this.mode = 'reader'; this.updateUrl(''); this.render(); }

  async showImage(button) {
    const [partIndex, imageIndex] = button.dataset.v2DocumentImage.split(':').map(Number);
    const documentRow = this.list('documents').find(row => row.id === this.selectedId);
    const file = this.partsFor(documentRow)[partIndex]?.sources?.files?.[imageIndex]?.display_copy;
    if (!file) return;
    button.disabled = true; button.textContent = 'Hämtar…';
    try {
      const url = await this.imageLoader(file);
      const stage = this.view.querySelector(`[data-v2-document-image-stage="${partIndex}"]`);
      stage.innerHTML = `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(file.filename)}"><figcaption>${escapeHtml(file.filename)}</figcaption></figure>`;
      button.textContent = `Bild ${imageIndex + 1}`;
    } catch (error) { button.textContent = `Kunde inte visa bilden · ${error.message}`; }
    finally { button.disabled = false; }
  }
}
