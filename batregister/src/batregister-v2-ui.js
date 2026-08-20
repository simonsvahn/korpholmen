const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

export const CATEGORY_LABELS = Object.freeze({
  motorboat: 'Motorbåt',
  sailboat: 'Segelbåt',
  rowboat: 'Rodbåt',
  kayak: 'Kajak/kanot',
  surfboard: 'Bräda',
  other: 'Övrigt',
});

export const VESSEL_DESIGNATIONS = Object.freeze([
  'M/S',
  'S/S',
  'R/S',
  'M/Y',
  'M/F',
  'b/s',
  'r/j',
]);

export const EVENT_LABELS = Object.freeze({
  observed: 'Belagd',
  manufactured: 'Tillverkad',
  name_decided: 'Namn beslutat',
  renamed: 'Namnbyte',
  ownership: 'Ägare',
  purchased: 'Köpt',
  sold: 'Såld',
  registered: 'Inregistrerad',
  deregistered: 'Avregistrerad',
  other: 'Övrig händelse',
});

const OWNER_EVENTS = new Set(['ownership', 'purchased', 'sold', 'registered']);
const LEGACY_SPEC_LABELS = Object.freeze({ category: 'Kategori', model: 'Modell', construction_year: 'Tillverkad', sail_number: 'Segelnummer', length_m: 'Längd', width_m: 'Bredd', draft_m: 'Djupgående', weight_kg: 'Vikt', displacement_t: 'Deplacement', construction_material: 'Material', engine_brand: 'Motormärke', engine_model: 'Motormodell', engine_count: 'Antal motorer', horsepower: 'Motorstyrka', engine_power_kw: 'Motoreffekt', fuel: 'Drivmedel', propulsion: 'Framdrivning', color: 'Färg', race_class: 'Tävlingsklass' });
const option = (value, label, selected = false) => `<option value="${escapeAttribute(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const vesselDesignationOptions = current => {
  const values = current && !VESSEL_DESIGNATIONS.includes(current) ? [current, ...VESSEL_DESIGNATIONS] : VESSEL_DESIGNATIONS;
  return `${option('', 'Ej angiven', !current)}${values.map(value => option(value, value, current === value)).join('')}`;
};
const vesselDesignation = boat => boat?.vessel_designation || (VESSEL_DESIGNATIONS.includes(boat?.vessel_type) ? boat.vessel_type : '');
const vesselType = boat => (boat?.vessel_designation || !VESSEL_DESIGNATIONS.includes(boat?.vessel_type)) ? (boat?.vessel_type || '') : '';

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(parsed)) throw new Error('Ett numeriskt fält innehåller inte ett giltigt tal.');
  return parsed;
}

export function boatTimeLabel(time) {
  if (!time) return 'Tid okänd';
  if (time.original_text?.trim()) return time.original_text.trim();
  const start = time.start_min ?? time.start_max;
  const end = time.end_max ?? time.end_min;
  if (start != null && end != null && start !== end) return `${start}–${end}`;
  return String(start ?? end ?? 'Tid okänd');
}

function ownerNames(runtime, boat) {
  const owners = runtime.latestOwners(boat).map(owner => owner.display_name);
  return owners.length ? owners.join(', ') : '';
}

function boatSearch(runtime, boat) {
  const legacy = runtime.legacySummary(boat);
  return normalize([
    boat.display_name,
    vesselDesignation(boat),
    boat.model,
    vesselType(boat),
    boat.material,
    boat.notes,
    CATEGORY_LABELS[boat.category],
    ...runtime.eventsFor(boat).flatMap(event => [EVENT_LABELS[event.event_type], event.comment, boatTimeLabel(event.time), ...runtime.ownersForEvent(event).map(owner => owner.display_name)]),
    legacy?.base?.agare,
    legacy?.base?.modell,
    legacy?.base?.motor,
    legacy?.base?.notering,
    ...Object.values(legacy?.effectiveSpecs || {}),
    ...(legacy?.ownerships || []).flatMap(row => [row.party_label, row.legacy_owner_text]),
    ...(legacy?.events || []).flatMap(row => [row.label, row.event_type]),
    ...(legacy?.reviews || []).flatMap(row => [row.known, row.question]),
  ].join(' '));
}

function legacyDate(value) {
  if (!value) return 'Tid okänd';
  if (value.original_text) return value.original_text;
  if (value.precision === 'not_later_than') return `senast ${value.year}`;
  if (value.precision === 'observed') return `belagd ${value.year}`;
  return String(value.year || 'Tid okänd');
}

function legacySpecValue(key, value) {
  if (value === null || value === undefined || value === '') return '';
  if (key.endsWith('_m')) return `${value} m`;
  if (key === 'weight_kg') return `${value} kg`;
  if (key === 'displacement_t') return `${value} ton`;
  if (key === 'horsepower') return `${value} hk`;
  if (key === 'engine_power_kw') return `${value} kW`;
  if (key === 'category') return CATEGORY_LABELS[value] || value;
  return String(value);
}

function legacyOwner(runtime, row) {
  const party = row.party_id ? runtime.resolveParty({ master: 'people', entity_type: row.party_type === 'family-unit' ? 'family_unit' : 'person', entity_id: row.party_id }) : null;
  return party?.display_name || row.party_label || row.legacy_owner_text || 'Ägare ej namngiven';
}

function legacySupplementMarkup(runtime, boat) {
  const legacy = runtime.legacySummary(boat);
  if (!legacy) return '';
  const baseFacts = [
    valueLine('Äldre typ', legacy.base?.typ),
    valueLine('Äldre modell', legacy.base?.modell),
    valueLine('Äldre period', legacy.base?.period),
    valueLine('Äldre ägartext', legacy.base?.agare),
  ].join('');
  const specs = Object.entries(legacy.effectiveSpecs || {}).map(([key, value]) => `<div><dt>${escapeHtml(LEGACY_SPEC_LABELS[key] || key)}</dt><dd>${escapeHtml(legacySpecValue(key, value))}</dd></div>`).join('');
  const owners = legacy.ownerships.filter(row => !row.status || row.status === 'accepted').map(row => `<li><time>${escapeHtml([row.start ? legacyDate(row.start) : '', row.end ? `till ${legacyDate(row.end)}` : ''].filter(Boolean).join(' · ') || 'Tid okänd')}</time><b>${escapeHtml(legacyOwner(runtime, row))}</b>${row.legacy_owner_text && row.legacy_owner_text !== row.party_label ? `<small>${escapeHtml(row.legacy_owner_text)}</small>` : ''}</li>`).join('');
  const events = legacy.events.filter(row => !row.status || row.status === 'accepted').map(row => `<li><time>${escapeHtml(legacyDate(row.date))}</time><b>${escapeHtml(row.label || row.event_type)}</b></li>`).join('');
  const reviews = legacy.reviews.map(row => `<article><b>${escapeHtml(row.question || 'Se över uppgiften')}</b>${row.known ? `<p>${escapeHtml(row.known)}</p>` : ''}</article>`).join('');
  return `<section class="drawer-section v2-legacy-supplement"><header><div><h3>Tidigare strukturerad master</h3><p>Visas som läskomplement. Uppgifterna skrivs inte automatiskt in i V2.</p></div><span>${legacy.sources.length} källor</span></header>${baseFacts || specs ? `<dl class="v2-boat-facts">${baseFacts}${specs}</dl>` : ''}${owners ? `<h4>Godkända ägaruppgifter</h4><ol class="v2-legacy-list">${owners}</ol>` : ''}${events ? `<h4>Godkänd historik</h4><ol class="v2-legacy-list">${events}</ol>` : ''}${reviews ? `<h4>Se över</h4><div class="v2-legacy-reviews">${reviews}</div>` : ''}</section>`;
}

function valueLine(label, value) {
  return value === undefined || value === null || value === '' ? '' : `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function dimensionText(dimensions = {}) {
  return [
    dimensions.length_m != null ? `${dimensions.length_m} m lång` : '',
    dimensions.width_m != null ? `${dimensions.width_m} m bred` : '',
    dimensions.draft_m != null ? `${dimensions.draft_m} m djupgående` : '',
    dimensions.weight_kg != null ? `${dimensions.weight_kg} kg` : '',
  ].filter(Boolean).join(' · ');
}

function engineText(engine = {}) {
  return [engine.brand, engine.model, engine.horsepower != null ? `${engine.horsepower} hk` : '', engine.power_kw != null ? `${engine.power_kw} kW` : '', engine.fuel].filter(Boolean).join(' · ');
}

function ownerLinks(runtime, event) {
  return runtime.ownersForEvent(event).map(owner => owner.kind === 'person'
    ? `<a href="../personer-familjer/?person=${encodeURIComponent(owner.person.id)}">${escapeHtml(owner.display_name)}</a>`
    : `<span>${escapeHtml(owner.display_name)}</span>`).join(', ');
}

function eventCard(runtime, event, writable) {
  const owners = ownerLinks(runtime, event);
  const names = event.event_type === 'renamed' ? `${event.name_before} → ${event.name_after}` : event.event_type === 'name_decided' ? event.decided_name : '';
  return `<article class="v2-boat-event"><time>${escapeHtml(boatTimeLabel(event.time))}</time><div><b>${escapeHtml(EVENT_LABELS[event.event_type] || event.event_type)}</b>${owners ? `<p>${owners}</p>` : ''}${names ? `<p>${escapeHtml(names)}</p>` : ''}${event.comment ? `<p>${escapeHtml(event.comment)}</p>` : ''}</div>${writable ? `<button type="button" data-v2-edit-event="${escapeAttribute(event.id)}">Ändra</button>` : ''}</article>`;
}

export class BatregisterV2Controller {
  constructor({ runtime, writer = null, content, drawer, drawerContent, backdrop, statusNode, renderImage, renderGallery, hydrateImages, uploadImage, onSaved } = {}) {
    this.runtime = runtime;
    this.writer = writer;
    this.content = content;
    this.drawer = drawer;
    this.drawerContent = drawerContent;
    this.backdrop = backdrop;
    this.statusNode = statusNode;
    this.renderImage = renderImage || (() => '<div class="image-placeholder">Bild saknas</div>');
    this.renderGallery = renderGallery || (() => '');
    this.hydrateImages = hydrateImages || (() => {});
    this.uploadImage = uploadImage || null;
    this.onSaved = onSaved;
    this.selectedBoatId = null;
    this.category = '';
    this.imageStatus = '';
    this.supplementStatus = '';
    this.dialog = null;
    this.saving = false;
  }

  setWriter(writer) {
    this.writer = writer;
    const addButton = document.querySelector('#add-boat');
    if (addButton) addButton.hidden = !writer;
    this.render();
    if (this.selectedBoatId) this.open(this.selectedBoatId, { updateUrl: false });
  }

  setFilter(kind, value) {
    if (kind === 'category') this.category = value;
    if (kind === 'image') this.imageStatus = value;
    this.render();
  }

  configureShell() {
    const typeOptions = document.querySelector('#type-options');
    if (typeOptions) typeOptions.innerHTML = `<button type="button" data-type-filter="">Alla</button>${Object.entries(CATEGORY_LABELS).map(([value, label]) => `<button type="button" data-type-filter="${value}">${escapeHtml(label)}</button>`).join('')}`;
    document.querySelector('#name-options')?.closest('.panel-section')?.setAttribute('hidden', '');
    document.querySelector('#quality-filter-section')?.setAttribute('hidden', '');
    document.querySelector('#pilot-filter-section')?.setAttribute('hidden', '');
    document.querySelector('#view-panel-toggle')?.setAttribute('hidden', '');
    document.querySelector('#owner-review-toggle')?.setAttribute('hidden', '');
    document.querySelector('#connection-filter')?.closest('.panel-section')?.setAttribute('hidden', '');
    const addButton = document.querySelector('#add-boat');
    if (addButton) addButton.hidden = !this.writer;
    const qualitySection = document.querySelector('#quality-filter-section');
    if (qualitySection) {
      qualitySection.removeAttribute('hidden');
      qualitySection.querySelector('h2').textContent = 'Datagranskning';
      qualitySection.querySelector('.filter-help').textContent = 'Visar vad som redan finns strukturerat i V2 eller i den tidigare mastern.';
      qualitySection.querySelector('#quality-options').innerHTML = '<button type="button" data-v2-supplement-filter="">Alla</button><button type="button" data-v2-supplement-filter="structured">Med äldre strukturerad data</button><button type="button" data-v2-supplement-filter="review">Med se-över-fråga</button>';
      qualitySection.querySelector('#quality-options').addEventListener('click', event => {
        const button = event.target.closest('[data-v2-supplement-filter]');
        if (!button) return;
        this.supplementStatus = button.dataset.v2SupplementFilter;
        this.render();
      });
    }
  }

  visibleBoats() {
    const needle = normalize(document.querySelector('#search')?.value || '');
    return this.runtime.listBoats().filter(boat => {
      if (this.category && boat.category !== this.category) return false;
      if (this.imageStatus === 'with' && !(boat.images || []).length) return false;
      if (this.imageStatus === 'without' && (boat.images || []).length) return false;
      const legacy = this.runtime.legacySummary(boat);
      if (this.supplementStatus === 'structured' && !legacy) return false;
      if (this.supplementStatus === 'review' && !(boat.needs_review || legacy?.reviews.length)) return false;
      return !needle || boatSearch(this.runtime, boat).includes(needle);
    });
  }

  render() {
    const boats = this.visibleBoats();
    const total = this.runtime.listBoats().length;
    const count = document.querySelector('#filter-count');
    if (count) count.textContent = `${boats.length} av ${total} båtar`;
    for (const button of document.querySelectorAll('[data-type-filter]')) button.setAttribute('aria-pressed', String(button.dataset.typeFilter === this.category));
    for (const button of document.querySelectorAll('[data-image-status]')) button.setAttribute('aria-pressed', String(button.dataset.imageStatus === this.imageStatus));
    for (const button of document.querySelectorAll('[data-v2-supplement-filter]')) button.setAttribute('aria-pressed', String(button.dataset.v2SupplementFilter === this.supplementStatus));
    this.content.innerHTML = total ? `<section class="group"><div class="register-heading"><div><p class="eyebrow dark">Båtmaster</p><h2>Båtar</h2></div><p>${this.writer ? 'Ändringar sparas som en ny masterrevision.' : 'Verifierad läsvy.'}</p></div><div class="boat-grid">${boats.map(boat => {
      const owners = ownerNames(this.runtime, boat);
      const legacy = this.runtime.legacySummary(boat);
      const legacyOwners = legacy?.ownerships.filter(row => !row.status || row.status === 'accepted').map(row => legacyOwner(this.runtime, row)).filter(Boolean) || [];
      const summary = [vesselDesignation(boat), CATEGORY_LABELS[boat.category] || CATEGORY_LABELS[legacy?.effectiveSpecs.category], vesselType(boat), boat.model || legacy?.effectiveSpecs.model || legacy?.base?.modell].filter(Boolean);
      return `<button class="boat-card" type="button" data-v2-boat="${escapeAttribute(boat.id)}">${this.renderImage(boat)}<span class="boat-copy"><h3>${escapeHtml(boat.display_name)}</h3>${summary.length ? `<p>${escapeHtml(summary.join(' · '))}</p>` : ''}${owners || legacyOwners.length ? `<p>${escapeHtml(owners || [...new Set(legacyOwners)].join(', '))}</p>` : ''}<span class="chips">${legacy ? '<span class="chip">Äldre struktur finns</span>' : ''}${boat.needs_review || legacy?.reviews.length ? '<span class="chip warn">Se över</span>' : ''}</span></span></button>`;
    }).join('')}</div>${boats.length ? '' : '<p class="empty-row">Inga båtar matchar filtren.</p>'}</section>` : '<section class="empty"><h2>Ingen Båtmaster på den här enheten ännu</h2><p>Anslut Dropbox för att läsa generation 2.</p></section>';
    this.hydrateImages(this.content);
  }

  open(boatId, { updateUrl = true } = {}) {
    const boat = this.runtime.getBoat(boatId);
    if (!boat) return;
    this.selectedBoatId = boatId;
    const events = this.runtime.eventsFor(boat);
    const details = [
      valueLine('Kategori', CATEGORY_LABELS[boat.category]),
      valueLine('Fartygsbeteckning', vesselDesignation(boat)),
      valueLine('Båttyp', vesselType(boat)),
      valueLine('Modell', boat.model),
      valueLine('Material', boat.material),
      valueLine('Mått', dimensionText(boat.dimensions)),
      valueLine('Motor', engineText(boat.engine)),
    ].join('');
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">Båt</p><h2 class="drawer-title">${escapeHtml(boat.display_name)}</h2></div>${this.writer ? '<button class="edit-toggle" type="button" data-v2-edit-boat>Redigera</button>' : ''}</header>${this.renderGallery(boat)}<dl class="v2-boat-facts">${details || '<div><dt>V2-fakta</dt><dd>Inga ytterligare strukturerade uppgifter i V2 ännu.</dd></div>'}</dl>${boat.notes ? `<section class="drawer-section"><h3>Not</h3><p>${escapeHtml(boat.notes)}</p></section>` : ''}${boat.needs_review && boat.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(boat.review_comment)}</p></section>` : ''}<section class="drawer-section"><div class="v2-section-heading"><div><h3>Aktiv V2-tidslinje</h3><p>${events.length} ${events.length === 1 ? 'händelse' : 'händelser'}</p></div>${this.writer ? '<button class="primary" type="button" data-v2-new-event>Ny händelse</button>' : ''}</div><div class="v2-event-list">${events.map(event => eventCard(this.runtime, event, Boolean(this.writer))).join('') || '<p>Ingen strukturerad V2-händelse ännu.</p>'}</div></section>${legacySupplementMarkup(this.runtime, boat)}${(boat.source_ids || []).length ? `<details class="drawer-section"><summary>V2-källkopplingar (${boat.source_ids.length})</summary><ul>${boat.source_ids.map(source => `<li><code>${escapeHtml(source)}</code></li>`).join('')}</ul></details>` : ''}${this.writer ? `<section class="drawer-section"><h3>Bilder</h3><p>${(boat.images || []).length} bildposter.</p><input id="v2-image-upload" type="file" accept="image/*"></section>` : ''}`;
    this.drawer.setAttribute('aria-hidden', 'false');
    this.backdrop.hidden = false;
    this.hydrateImages(this.drawer);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('boat', boatId);
      history.replaceState(null, '', url);
    }
  }

  close() {
    if (this.saving) return;
    this.drawer.setAttribute('aria-hidden', 'true');
    this.backdrop.hidden = true;
    this.drawerContent.innerHTML = '';
    this.selectedBoatId = null;
    const url = new URL(location.href);
    url.searchParams.delete('boat');
    history.replaceState(null, '', url);
  }

  partyOptions(selectedReferences = []) {
    const selected = new Set(selectedReferences.map(reference => `${reference.entity_type}|${reference.entity_id}`));
    return this.runtime.partyOptions().map(row => option(row.value, row.label, selected.has(row.value))).join('');
  }

  openBoatEditor(boat = null) {
    if (!this.writer) return;
    this.dialog?.remove();
    const dimensions = boat?.dimensions || {};
    const engine = boat?.engine || {};
    const dialog = document.createElement('dialog');
    dialog.className = 'v2-editor';
    dialog.dataset.boatId = boat?.id || `boat-${crypto.randomUUID()}`;
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow dark">${boat ? 'Båt' : 'Ny båt'}</p><h2>${boat ? 'Redigera båten' : 'Lägg till båt'}</h2></div><button type="button" data-v2-close-editor aria-label="Stäng">×</button></header><div class="v2-editor-grid"><label><span>Namn</span><input data-v2-display-name required value="${escapeAttribute(boat?.display_name || '')}"></label><label><span>Kategori</span><select data-v2-category>${option('', 'Ej angiven', !boat?.category)}${Object.entries(CATEGORY_LABELS).map(([value, label]) => option(value, label, boat?.category === value)).join('')}</select></label><label><span>Fartygsbeteckning</span><select data-v2-vessel-designation>${vesselDesignationOptions(vesselDesignation(boat))}</select></label><label><span>Båttyp</span><input data-v2-vessel-type value="${escapeAttribute(vesselType(boat))}" placeholder="t.ex. Söderöra-snipa"></label><label><span>Modell</span><input data-v2-model value="${escapeAttribute(boat?.model || '')}"></label><label><span>Material</span><input data-v2-material value="${escapeAttribute(boat?.material || '')}"></label><label><span>Längd, m</span><input data-v2-length type="number" step="0.01" value="${escapeAttribute(dimensions.length_m ?? '')}"></label><label><span>Bredd, m</span><input data-v2-width type="number" step="0.01" value="${escapeAttribute(dimensions.width_m ?? '')}"></label><label><span>Djupgående, m</span><input data-v2-draft type="number" step="0.01" value="${escapeAttribute(dimensions.draft_m ?? '')}"></label><label><span>Vikt, kg</span><input data-v2-weight type="number" step="0.1" value="${escapeAttribute(dimensions.weight_kg ?? '')}"></label><label><span>Motormärke</span><input data-v2-engine-brand value="${escapeAttribute(engine.brand || '')}"></label><label><span>Motormodell</span><input data-v2-engine-model value="${escapeAttribute(engine.model || '')}"></label><label><span>Hästkrafter</span><input data-v2-horsepower type="number" step="0.1" value="${escapeAttribute(engine.horsepower ?? '')}"></label><label><span>Effekt, kW</span><input data-v2-power-kw type="number" step="0.1" value="${escapeAttribute(engine.power_kw ?? '')}"></label><label><span>Bränsle/drivning</span><input data-v2-fuel value="${escapeAttribute(engine.fuel || '')}"></label><label class="v2-editor-wide"><span>Not</span><textarea data-v2-notes>${escapeHtml(boat?.notes || '')}</textarea></label></div><label class="v2-review-check"><input data-v2-needs-review type="checkbox"${boat?.needs_review ? ' checked' : ''}><span>Det finns något jag vill se över senare</span></label><label class="v2-review-comment"><span>Kort granskningsnot</span><input data-v2-review-comment value="${escapeAttribute(boat?.review_comment || '')}"></label><footer><button type="button" data-v2-close-editor>Stäng</button><button class="primary" type="submit">Spara</button></footer></form>`;
    this.installDialog(dialog, event => this.saveBoatEditor(event, boat));
  }

  openEventEditor(event = null) {
    if (!this.writer || !this.selectedBoatId) return;
    this.dialog?.remove();
    const time = event?.time || {};
    const references = (event?.participants || []).map(row => row.party_ref);
    const dialog = document.createElement('dialog');
    dialog.className = 'v2-editor';
    dialog.dataset.eventId = event?.id || `event:${this.selectedBoatId}:${crypto.randomUUID()}`;
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow dark">Tidslinje</p><h2>${event ? 'Ändra händelsen' : 'Ny händelse'}</h2></div><button type="button" data-v2-close-editor aria-label="Stäng">×</button></header><div class="v2-editor-grid"><label><span>Händelse</span><select data-v2-event-type required>${Object.entries(EVENT_LABELS).map(([value, label]) => option(value, label, event?.event_type === value)).join('')}</select></label><label><span>Tidsform</span><select data-v2-time-kind>${option('point', 'År/tidpunkt', time.kind === 'point' || (!time.kind && event?.event_type !== 'ownership'))}${option('period', 'Period', time.kind === 'period')}${option('observation', 'Belagd tid', time.kind === 'observation')}${option('', 'Tid saknas (bara Ägare)', !time.kind && event?.event_type === 'ownership')}</select></label><label><span>Så tiden ska visas</span><input data-v2-time-text value="${escapeAttribute(time.original_text || boatTimeLabel(time).replace('Tid okänd', ''))}" placeholder="t.ex. 1970-talet"></label><label><span>Start tidigast</span><input data-v2-start-min type="number" min="1600" max="2200" value="${escapeAttribute(time.start_min ?? '')}"></label><label><span>Start senast</span><input data-v2-start-max type="number" min="1600" max="2200" value="${escapeAttribute(time.start_max ?? '')}"></label><label><span>Slut tidigast</span><input data-v2-end-min type="number" min="1600" max="2200" value="${escapeAttribute(time.end_min ?? '')}"></label><label><span>Slut senast</span><input data-v2-end-max type="number" min="1600" max="2200" value="${escapeAttribute(time.end_max ?? '')}"></label><label><span>Precision</span><select data-v2-precision>${option('', 'Ej angiven', !time.precision)}${option('year', 'År', time.precision === 'year')}${option('decade', 'Årtionde', time.precision === 'decade')}${option('month', 'Månad', time.precision === 'month')}${option('day', 'Dag', time.precision === 'day')}</select></label><label><span>Kvalificering</span><select data-v2-qualifier>${option('', 'Ingen', !time.qualifier)}${option('about', 'Cirka', time.qualifier === 'about')}${option('before', 'Före', time.qualifier === 'before')}${option('after', 'Efter', time.qualifier === 'after')}${option('early', 'Tidigt', time.qualifier === 'early')}${option('middle', 'Mitten', time.qualifier === 'middle')}${option('late', 'Sent', time.qualifier === 'late')}</select></label><label class="v2-owner-field"><span>Ägare/personer</span><select data-v2-participants multiple size="8">${this.partyOptions(references)}</select><small>Välj flera med Cmd/Ctrl vid samägande.</small></label><label data-v2-renamed-before><span>Tidigare namn</span><input data-v2-name-before value="${escapeAttribute(event?.name_before || '')}"></label><label data-v2-renamed-after><span>Nytt namn</span><input data-v2-name-after value="${escapeAttribute(event?.name_after || '')}"></label><label data-v2-decided-name><span>Beslutat namn</span><input data-v2-decided-name-input value="${escapeAttribute(event?.decided_name || '')}"></label><label class="v2-editor-wide"><span>Kort kommentar</span><textarea data-v2-comment>${escapeHtml(event?.comment || '')}</textarea></label></div><footer>${event ? '<button class="v2-danger" type="button" data-v2-delete-event>Ta bort händelse</button>' : '<span></span>'}<button type="button" data-v2-close-editor>Stäng</button><button class="primary" type="submit">Spara</button></footer></form>`;
    dialog.addEventListener('change', change => { if (change.target.matches('[data-v2-event-type]')) this.toggleEventFields(dialog); });
    dialog.addEventListener('click', click => { if (click.target.closest('[data-v2-delete-event]')) this.deleteEvent(event); });
    this.installDialog(dialog, submit => this.saveEventEditor(submit, event));
    this.toggleEventFields(dialog);
  }

  installDialog(dialog, onSubmit) {
    document.body.append(dialog);
    this.dialog = dialog;
    dialog.addEventListener('click', event => { if (event.target.closest('[data-v2-close-editor]')) dialog.close(); });
    dialog.addEventListener('close', () => { if (!this.saving) { dialog.remove(); if (this.dialog === dialog) this.dialog = null; } });
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); onSubmit(event).catch(error => this.fail(error)); });
    dialog.showModal();
  }

  toggleEventFields(dialog) {
    const type = dialog.querySelector('[data-v2-event-type]').value;
    for (const node of dialog.querySelectorAll('[data-v2-renamed-before],[data-v2-renamed-after]')) node.hidden = type !== 'renamed';
    dialog.querySelector('[data-v2-decided-name]').hidden = type !== 'name_decided';
    dialog.querySelector('.v2-owner-field').classList.toggle('v2-required-owner', OWNER_EVENTS.has(type));
  }

  async saveBoatEditor(_submit, existing) {
    if (this.saving) return;
    const dialog = this.dialog;
    const name = dialog.querySelector('[data-v2-display-name]').value.trim();
    if (!name) throw new Error('Båten måste ha ett namn eller tydligt visningsnamn.');
    const dimensions = { ...(existing?.dimensions || {}) };
    const engine = { ...(existing?.engine || {}) };
    for (const [field, selector] of [['length_m', '[data-v2-length]'], ['width_m', '[data-v2-width]'], ['draft_m', '[data-v2-draft]'], ['weight_kg', '[data-v2-weight]']]) {
      const value = numeric(dialog.querySelector(selector).value);
      if (value === null) delete dimensions[field]; else dimensions[field] = value;
    }
    for (const [field, selector, number] of [['brand', '[data-v2-engine-brand]', false], ['model', '[data-v2-engine-model]', false], ['horsepower', '[data-v2-horsepower]', true], ['power_kw', '[data-v2-power-kw]', true], ['fuel', '[data-v2-fuel]', false]]) {
      const raw = dialog.querySelector(selector).value.trim();
      if (!raw) delete engine[field]; else engine[field] = number ? numeric(raw) : raw;
    }
    const needsReview = dialog.querySelector('[data-v2-needs-review]').checked;
    const reviewComment = dialog.querySelector('[data-v2-review-comment]').value.trim();
    if (needsReview && !reviewComment) throw new Error('Skriv en kort granskningsnot eller avmarkera rutan.');
    const patch = {
      display_name: name,
      base_name_id: existing?.base_name_id || dialog.dataset.boatId,
      category: dialog.querySelector('[data-v2-category]').value || null,
      vessel_designation: dialog.querySelector('[data-v2-vessel-designation]').value || null,
      model: dialog.querySelector('[data-v2-model]').value.trim() || null,
      vessel_type: dialog.querySelector('[data-v2-vessel-type]').value.trim() || null,
      material: dialog.querySelector('[data-v2-material]').value.trim() || null,
      dimensions: Object.keys(dimensions).length ? dimensions : null,
      engine: Object.keys(engine).length ? engine : null,
      notes: dialog.querySelector('[data-v2-notes]').value.trim() || null,
      needs_review: needsReview,
      review_comment: needsReview ? reviewComment : '',
    };
    if (!existing) Object.assign(patch, { events: [], images: [], source_ids: [] });
    const saved = await this.save(() => this.writer.saveBoat(dialog.dataset.boatId, patch, { manualComment: existing ? 'Båtuppgifter ändrade i appen' : 'Båt skapad i appen' }), dialog);
    this.selectedBoatId = dialog.dataset.boatId;
    return saved;
  }

  eventFromDialog() {
    const dialog = this.dialog;
    const type = dialog.querySelector('[data-v2-event-type]').value;
    const kind = dialog.querySelector('[data-v2-time-kind]').value;
    const time = kind ? { kind } : null;
    if (time) {
      const text = dialog.querySelector('[data-v2-time-text]').value.trim();
      if (text) time.original_text = text;
      for (const [field, selector] of [['start_min', '[data-v2-start-min]'], ['start_max', '[data-v2-start-max]'], ['end_min', '[data-v2-end-min]'], ['end_max', '[data-v2-end-max]']]) {
        const value = numeric(dialog.querySelector(selector).value);
        if (value !== null) time[field] = value;
      }
      const precision = dialog.querySelector('[data-v2-precision]').value;
      const qualifier = dialog.querySelector('[data-v2-qualifier]').value;
      if (precision) time.precision = precision;
      if (qualifier) time.qualifier = qualifier;
      if (![time.start_min, time.start_max, time.end_min, time.end_max].some(value => value != null) && !time.original_text) throw new Error('Ange ett år eller skriv hur tiden ska visas.');
    } else if (type !== 'ownership') throw new Error('Bara händelsen Ägare får sakna tidsangivelse.');
    const references = [...dialog.querySelector('[data-v2-participants]').selectedOptions].map(selected => this.runtime.partyOptions().find(row => row.value === selected.value)?.reference).filter(Boolean);
    if (OWNER_EVENTS.has(type) && !references.length) throw new Error(`${EVENT_LABELS[type]} kräver minst en kopplad ägare.`);
    const value = { id: dialog.dataset.eventId, event_type: type, ...(time ? { time } : {}), participants: references.map(party_ref => ({ party_ref, role: 'owner' })) };
    const comment = dialog.querySelector('[data-v2-comment]').value.trim();
    if (comment) value.comment = comment;
    if (type === 'renamed') {
      value.name_before = dialog.querySelector('[data-v2-name-before]').value.trim();
      value.name_after = dialog.querySelector('[data-v2-name-after]').value.trim();
      if (!value.name_before || !value.name_after) throw new Error('Namnbyte kräver både tidigare och nytt namn.');
    }
    if (type === 'name_decided') {
      value.decided_name = dialog.querySelector('[data-v2-decided-name-input]').value.trim();
      if (!value.decided_name) throw new Error('Skriv vilket namn som beslutades.');
    }
    return value;
  }

  async saveEventEditor(_submit, existing) {
    const boat = this.runtime.getBoat(this.selectedBoatId);
    const value = this.eventFromDialog();
    const events = [...(boat.events || [])];
    const index = events.findIndex(row => row.id === existing?.id);
    if (index >= 0) events[index] = value; else events.push(value);
    return this.save(() => this.writer.saveBoat(boat.id, { events }, { manualComment: existing ? 'Båthändelse ändrad i appen' : 'Båthändelse skapad i appen' }), this.dialog);
  }

  async deleteEvent(existing) {
    if (!existing || !confirm(`Ta bort händelsen ${EVENT_LABELS[existing.event_type] || existing.event_type}? Ändringen sparas i historiken.`)) return;
    const boat = this.runtime.getBoat(this.selectedBoatId);
    const events = (boat.events || []).filter(row => row.id !== existing.id);
    await this.save(() => this.writer.saveBoat(boat.id, { events }, { manualComment: 'Båthändelse borttagen i appen' }), this.dialog);
  }

  async handleImage(file) {
    if (!file || !this.writer || !this.uploadImage || !this.selectedBoatId) return;
    this.saving = true;
    try {
      this.statusNode.textContent = 'Förbereder och sparar bilden…';
      const saved = await this.uploadImage({ file, boat: this.runtime.getBoat(this.selectedBoatId), writer: this.writer });
      await this.onSaved?.(saved);
      this.render();
      this.open(this.selectedBoatId, { updateUrl: false });
      this.statusNode.textContent = `Bild sparad · Båtmaster revision ${saved.master.master_revision}`;
      this.statusNode.className = 'status-ok';
    } finally { this.saving = false; }
  }

  async save(action, dialog) {
    if (this.saving) return null;
    this.saving = true;
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')];
    controls.forEach(node => { node.disabled = true; });
    this.statusNode.textContent = 'Sparar en ny Båtmasterrevision…';
    this.statusNode.className = '';
    try {
      const saved = await action();
      await this.onSaved?.(saved);
      dialog.close();
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
      this.render();
      this.open(this.selectedBoatId || saved.receipt.changes[0].entity_id, { updateUrl: false });
      this.statusNode.textContent = `Sparat · Båtmaster revision ${saved.master.master_revision} · historikkvitto skapat`;
      this.statusNode.className = 'status-ok';
      return saved;
    } finally {
      this.saving = false;
      controls.forEach(node => { node.disabled = false; });
    }
  }

  fail(error) {
    this.statusNode.textContent = error.message;
    this.statusNode.className = 'status-error';
  }
}

export function createBatregisterV2Controller(options) {
  return new BatregisterV2Controller(options);
}
