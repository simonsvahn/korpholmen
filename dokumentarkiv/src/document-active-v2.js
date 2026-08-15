import { createActiveAppBundle } from '../core/active-app-bundle.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const timeLabel = time => time?.original_text || time?.start_min || time?.start_max || 'Odaterat';

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
  }

  async init() { await this.bundle.init(); return this; }
  hasData() { return this.bundle.hasData('documents'); }
  async sync(transport) { return this.bundle.sync(transport); }
  list(name) { return this.bundle.list('documents', name); }

  configureShell() {
    document.documentElement.dataset.documentV2 = 'true';
    document.querySelector('#view-tabs')?.setAttribute('hidden', '');
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
    });
  }

  categories() { return new Map(this.list('document_categories').map(row => [row.id, row.display_name])); }
  types() { return new Map(this.list('document_types').map(row => [row.id, row.display_name])); }
  partsFor(document) { const ids = new Set(document.part_ids || []); return this.list('document_parts').filter(row => ids.has(row.id) || row.document_ref?.entity_id === document.id).sort((a, b) => a.order - b.order); }
  linksFor(document) { return this.list('document_links').filter(row => row.document_ref?.entity_id === document.id || row.source_document_ref?.entity_id === document.id || row.document_id === document.id); }
  searchText(document) { return normalize([document.title, timeLabel(document.time), ...this.partsFor(document).map(part => part.transcription?.text), ...this.linksFor(document).flatMap(link => link.source_labels || [])].join(' ')); }

  visible() {
    const needle = normalize(this.search);
    return this.list('documents').filter(document => (!this.category || document.category_id === this.category) && (!needle || this.searchText(document).includes(needle)))
      .sort((a, b) => String(timeLabel(b.time)).localeCompare(String(timeLabel(a.time)), 'sv') || a.title.localeCompare(b.title, 'sv'));
  }

  render() {
    if (this.selectedId) return this.open(this.selectedId, { updateUrl: false });
    const categories = this.categories();
    const select = document.querySelector('#v2-document-category');
    if (select && select.options.length === 1) select.insertAdjacentHTML('beforeend', [...categories].map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join(''));
    const documents = this.visible();
    document.querySelector('#document-total').textContent = String(this.list('documents').length);
    const years = this.list('documents').map(row => row.time?.start_min).filter(Number.isFinite);
    document.querySelector('#year-range').textContent = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—';
    const count = document.querySelector('#v2-document-count'); if (count) count.textContent = `${documents.length} av ${this.list('documents').length}`;
    this.view.innerHTML = documents.length ? `<section class="v2-document-list">${documents.map(document => `<button type="button" data-v2-document="${escapeHtml(document.id)}"><time>${escapeHtml(timeLabel(document.time))}</time><span><b>${escapeHtml(document.title)}</b><small>${escapeHtml(categories.get(document.category_id) || document.category_id)} · ${(document.part_ids || []).length} ${(document.part_ids || []).length === 1 ? 'del' : 'delar'} · ${this.linksFor(document).length} länkar</small></span></button>`).join('')}</section>` : '<section class="tomtresultat"><h2>Inga dokument</h2><p>Anslut Dropbox eller ändra filtren.</p></section>';
  }

  open(id, { updateUrl = true } = {}) {
    const documentRow = this.list('documents').find(row => row.id === id);
    if (!documentRow) return;
    this.selectedId = id;
    const types = this.types();
    const links = this.linksFor(documentRow);
    this.view.innerHTML = `<article class="v2-document-reader"><button type="button" data-v2-document-back>← Alla dokument</button><header><p>${escapeHtml(timeLabel(documentRow.time))}</p><h2>${escapeHtml(documentRow.title)}</h2><small>${(documentRow.type_ids || []).map(type => types.get(type) || type).map(escapeHtml).join(' · ')}</small></header>${links.length ? `<section class="v2-document-links"><h3>Kopplingar</h3>${links.map(link => `<span>${escapeHtml((link.source_labels || []).join(' · ') || link.target_ref?.entity_id || 'Länk')}</span>`).join('')}</section>` : ''}${this.partsFor(documentRow).map((part, partIndex) => { const files = part.sources?.files || []; return `<section class="v2-document-part"><header><h3>${escapeHtml(part.title || `Del ${partIndex + 1}`)}</h3><span>${files.length} ${files.length === 1 ? 'bild' : 'bilder'}</span></header>${files.length ? `<div class="v2-document-images">${files.map((file, imageIndex) => `<button type="button" data-v2-document-image="${partIndex}:${imageIndex}">Visa bild ${imageIndex + 1}</button>`).join('')}</div><div data-v2-document-image-stage="${partIndex}"></div>` : ''}<div class="v2-transcription">${escapeHtml(part.transcription?.text || 'Avskrift saknas.').replaceAll('\n\n', '</p><p>').replaceAll('\n', '<br>')}</div></section>`; }).join('')}</article>`;
    if (updateUrl) { const url = new URL(location.href); url.searchParams.set('document', id); history.replaceState(null, '', url); }
  }

  close() { this.selectedId = ''; const url = new URL(location.href); url.searchParams.delete('document'); history.replaceState(null, '', url); this.render(); }

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
