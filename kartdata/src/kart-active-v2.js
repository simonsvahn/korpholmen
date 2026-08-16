import { createActiveAppBundle } from '../core/active-app-bundle.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'sv', { numeric: true });

export class KartActiveV2 {
  constructor({ store, content, summary } = {}) {
    this.bundle = createActiveAppBundle({ store, cacheKey: 'kart-active-v2', sources: {
      kart: { pointerPath: '/kartdata-generation2/active.json', app: 'kartdata', requiredCollections: ['places', 'place_names', 'entries', 'entry_names'] },
      properties: { pointerPath: '/fastigheter-generation2/active.json', app: 'fastigheter', requiredCollections: ['properties'] },
    } });
    this.content = content;
    this.summary = summary;
    this.search = '';
    this.exactEntry = '';
    this.type = '';
    this.subtype = '';
    this.placeFilter = '';
    this.sortKey = 'name';
    this.sortDirection = 1;
    this.mode = 'atlas';
  }

  async init() {
    await this.bundle.init();
    if (typeof location !== 'undefined') {
      const parameters = new URLSearchParams(location.search);
      const requestedPlace = parameters.get('place');
      if (requestedPlace) { this.placeFilter = requestedPlace; this.mode = 'structure'; }
      const requestedEntry = parameters.get('entry');
      if (requestedEntry) { this.search = requestedEntry; this.exactEntry = requestedEntry; this.mode = 'table'; }
    }
    return this;
  }
  hasData() { return this.bundle.hasData('kart'); }
  async sync(transport) { return this.bundle.sync(transport); }
  list(source, collection) { return this.bundle.list(source, collection); }
  place(id) { return this.bundle.get('kart', 'places', id); }
  property(id) { return this.bundle.get('properties', 'properties', id); }
  aliases(target, id) { return this.list('kart', target === 'place' ? 'place_names' : 'entry_names').filter(row => row[`${target}_id`] === id); }
  propertyIds(entry) { return (entry.property_refs || []).filter(ref => ref.master === 'fastigheter').map(ref => ref.entity_id); }
  placeIds(entry) {
    const direct = entry.place_ids || [];
    const throughProperties = this.propertyIds(entry).flatMap(id => (this.property(id)?.place_refs || []).filter(ref => ref.master === 'kartdata').map(ref => ref.entity_id));
    return [...new Set([...direct, ...throughProperties])];
  }
  placePath(placeId) {
    const place = this.place(placeId);
    if (!place) return '';
    const parent = place.parent_place_id ? this.place(place.parent_place_id) : null;
    return parent ? `${parent.preferred_name} › ${place.preferred_name}` : place.preferred_name;
  }
  rows() {
    const places = this.list('kart', 'places').map(place => ({
      key: `place:${place.id}`, id: place.id, name: place.preferred_name, type: 'platsobjekt', subtype: place.kind,
      places: place.parent_place_id ? [this.placePath(place.id)] : [place.preferred_name], properties: [],
      aliases: this.aliases('place', place.id).map(row => `${row.name} (${row.name_type})`),
    }));
    const entries = this.list('kart', 'entries').map(entry => ({
      key: `entry:${entry.id}`, id: entry.id, name: entry.name, type: entry.entry_type || 'plats', subtype: entry.subtype || '',
      places: this.placeIds(entry).map(id => this.placePath(id) || id),
      properties: this.propertyIds(entry).map(id => this.property(id)?.display_name || id),
      aliases: this.aliases('entry', entry.id).map(row => `${row.name} (${row.name_type})`),
      existence: entry.existence_status || '', nameStatus: entry.name_status || '',
    }));
    return [...places, ...entries];
  }
  visibleRows() {
    const needle = normalize(this.search);
    const requestedPlace = this.place(this.placeFilter)?.preferred_name || this.placeFilter;
    const factor = this.sortDirection;
    return this.rows().filter(row => {
      if (this.exactEntry && row.id !== this.exactEntry) return false;
      if (this.type && row.type !== this.type) return false;
      if (this.subtype && row.subtype !== this.subtype) return false;
      if (requestedPlace && !row.places.some(value => normalize(value).includes(normalize(requestedPlace)))) return false;
      return !needle || normalize([row.id, row.name, row.type, row.subtype, ...row.places, ...row.properties, ...row.aliases].join(' ')).includes(needle);
    }).sort((a, b) => {
      const values = row => ({ id: row.id, name: row.name, type: row.type, subtype: row.subtype, place: row.places.join(' '), property: row.properties.join(' '), aliases: row.aliases.join(' ') });
      return factor * (compare(values(a)[this.sortKey], values(b)[this.sortKey]) || compare(a.name, b.name));
    });
  }
  configureShell() {
    document.documentElement.dataset.kartV2 = 'true';
    const navigation = document.querySelector('.view-tabs');
    if (navigation) navigation.hidden = false;
    document.querySelector('#entry-drawer')?.setAttribute('hidden', '');
    document.querySelector('#backdrop')?.setAttribute('hidden', '');
    const toolbar = document.querySelector('.toolbar');
    toolbar.innerHTML = `<label class="field wide">Sök<input id="v2-kart-search" type="search" placeholder="Namn, alternativt namn, fastighet eller plats …"></label><label class="field">Typ<select id="v2-kart-type"><option value="">Alla typer</option></select></label><label class="field">Undertyp<select id="v2-kart-subtype"><option value="">Alla undertyper</option></select></label><label class="field">Plats<select id="v2-kart-place"><option value="">Alla platser</option></select></label><output id="v2-kart-count"></output>`;
    toolbar.querySelector('#v2-kart-search').addEventListener('input', event => { this.search = event.target.value; this.exactEntry = ''; this.render(); });
    toolbar.querySelector('#v2-kart-type').addEventListener('change', event => { this.type = event.target.value; this.render(); });
    toolbar.querySelector('#v2-kart-subtype').addEventListener('change', event => { this.subtype = event.target.value; this.render(); });
    toolbar.querySelector('#v2-kart-place').addEventListener('change', event => { this.placeFilter = event.target.value; this.render(); });
    toolbar.querySelector('#v2-kart-search').value = this.search;
    this.summary.innerHTML = '<div class="summary-copy"><p class="eyebrow dark">Aktiv V2-master</p><h2>Kartobjekt och namnformer</h2><p>Fastigheter är strukturerade länkar. Ö eller plats härleds via fastigheten när objektet inte har en egen platslänk.</p></div>';
  }
  setView(mode) { this.mode = ['atlas', 'structure', 'queue', 'table'].includes(mode) ? mode : 'atlas'; this.render(); }
  populateFilters() {
    const rows = this.rows();
    const fill = (selector, values) => { const node = document.querySelector(selector); if (node?.options.length === 1) node.insertAdjacentHTML('beforeend', values.sort(compare).map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')); };
    fill('#v2-kart-type', [...new Set(rows.map(row => row.type))]);
    fill('#v2-kart-subtype', [...new Set(rows.map(row => row.subtype).filter(Boolean))]);
    fill('#v2-kart-place', [...new Set(rows.flatMap(row => row.places).filter(Boolean))]);
  }
  sortButton(key, label) {
    const active = this.sortKey === key;
    return `<button type="button" data-sort="${key}" class="v2-sort ${active ? 'active' : ''}">${label}${active ? (this.sortDirection === 1 ? ' ↑' : ' ↓') : ''}</button>`;
  }
  updateChrome(rows) {
    document.querySelectorAll('.view-tabs [data-view]').forEach(button => {
      const active = button.dataset.view === this.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const count = document.querySelector('#v2-kart-count'); if (count) count.textContent = `${rows.length} av ${this.rows().length} poster`;
  }
  renderTable(rows) {
    return `<section class="v2-kart-table"><table><thead><tr><th>${this.sortButton('id', 'ID')}</th><th>${this.sortButton('name', 'Namn')}</th><th>${this.sortButton('type', 'Typ')}</th><th>${this.sortButton('subtype', 'Undertyp')}</th><th>${this.sortButton('place', 'Plats')}</th><th>${this.sortButton('property', 'Fastighet')}</th><th>${this.sortButton('aliases', 'Andra namn')}</th></tr></thead><tbody>${rows.map(row => `<tr><td><code>${escapeHtml(row.id)}</code></td><td><strong>${escapeHtml(row.name)}</strong>${row.existence === 'historical' ? '<small>Finns inte längre</small>' : ''}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.subtype || '—')}</td><td>${escapeHtml(row.places.join(', ') || '—')}</td><td>${row.properties.length ? row.properties.map(value => `<a href="../fastigheter/?property=${encodeURIComponent(value.match(/^[^(]+/)?.[0].trim() || value)}">${escapeHtml(value)}</a>`).join('<br>') : '—'}</td><td>${escapeHtml(row.aliases.join(', ') || '—')}</td></tr>`).join('')}</tbody></table></section>`;
  }
  renderAtlas(rows) {
    const places = this.list('kart', 'places');
    const types = new Map(); rows.forEach(row => types.set(row.type, (types.get(row.type) || 0) + 1));
    this.content.innerHTML = `<section class="v2-kart-atlas"><header><p class="eyebrow dark">Aktiv V2-master</p><h2>Platserna i ett svep</h2><p>Varje objekt hör antingen direkt till en plats eller till en fastighet som i sin tur hör till platsen.</p><div>${[['Platser', places.length], ['Kartobjekt', this.list('kart', 'entries').length], ['Namnformer', this.list('kart', 'place_names').length + this.list('kart', 'entry_names').length], ['Fastighetslänkar', this.list('kart', 'entries').reduce((sum, row) => sum + this.propertyIds(row).length, 0)]].map(([label, value]) => `<span><strong>${value}</strong>${label}</span>`).join('')}</div></header><div class="v2-kart-type-cards">${[...types].sort((a, b) => b[1] - a[1]).map(([type, count]) => `<article><h3>${escapeHtml(type)}</h3><b>${count}</b><span>poster</span></article>`).join('')}</div><div class="v2-kart-place-cards">${places.filter(place => !place.parent_place_id).sort((a, b) => compare(a.preferred_name, b.preferred_name)).map(place => { const names = this.aliases('place', place.id); const relevant = rows.filter(row => row.places.some(value => normalize(value).includes(normalize(place.preferred_name)))); return `<button type="button" data-v2-kart-place="${escapeHtml(place.preferred_name)}"><h3>${escapeHtml(place.preferred_name)}</h3><span>${escapeHtml(place.kind || 'plats')} · ${relevant.length} poster</span>${names.length ? `<small>${names.map(row => escapeHtml(row.name)).join(', ')}</small>` : ''}</button>`; }).join('')}</div></section>`;
  }
  renderStructure(rows) {
    const places = this.list('kart', 'places');
    const children = parentId => places.filter(row => row.parent_place_id === parentId).sort((a, b) => compare(a.preferred_name, b.preferred_name));
    const card = place => { const relevant = rows.filter(row => row.places.some(value => normalize(value).includes(normalize(place.preferred_name)))); return `<article><header><h3>${escapeHtml(place.preferred_name)}</h3><span>${escapeHtml(place.kind || 'plats')} · ${relevant.length} poster</span></header>${children(place.id).map(child => `<section><h4>${escapeHtml(child.preferred_name)}</h4><span>${escapeHtml(child.kind || 'plats')}</span></section>`).join('')}<div>${relevant.slice(0, 20).map(row => `<span><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.subtype || row.type)}</small></span>`).join('')}${relevant.length > 20 ? `<em>+ ${relevant.length - 20} till</em>` : ''}</div></article>`; };
    this.content.innerHTML = `<section class="v2-kart-structure"><header><h2>Östruktur</h2><p>Överordnade platser, underplatser och de objekt som knyts dit direkt eller via fastighet.</p></header><div>${places.filter(place => !place.parent_place_id).sort((a, b) => compare(a.preferred_name, b.preferred_name)).map(card).join('')}</div></section>`;
  }
  renderQueue(rows) {
    const attention = rows.filter(row => row.existence === 'historical' || row.nameStatus || !row.places.length);
    this.content.innerHTML = `<section class="v2-kart-queue"><header><h2>Granskningskö</h2><p>Poster med historisk status, särskild namnstatus eller utan härledd plats. Vyn ändrar ingenting.</p></header>${attention.length ? this.renderTable(attention) : '<div class="empty-state"><h3>Inga poster behöver särskild uppmärksamhet</h3></div>'}</section>`;
  }
  render() {
    this.populateFilters();
    const rows = this.visibleRows();
    this.updateChrome(rows);
    if (this.mode === 'atlas') this.renderAtlas(rows);
    else if (this.mode === 'structure') this.renderStructure(rows);
    else if (this.mode === 'queue') this.renderQueue(rows);
    else this.content.innerHTML = this.renderTable(rows);
    this.content.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
      if (this.sortKey === button.dataset.sort) this.sortDirection *= -1;
      else { this.sortKey = button.dataset.sort; this.sortDirection = 1; }
      this.render();
    }));
    this.content.querySelectorAll('[data-v2-kart-place]').forEach(button => button.addEventListener('click', () => {
      this.placeFilter = button.dataset.v2KartPlace;
      const select = document.querySelector('#v2-kart-place'); if (select) select.value = this.placeFilter;
      this.setView('structure');
    }));
  }
}
