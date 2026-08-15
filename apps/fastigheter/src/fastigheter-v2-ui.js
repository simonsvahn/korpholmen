const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

const ENTRY_LABELS = Object.freeze({
  ownership: 'Ägande',
  current_ownership: 'Nuvarande ägande',
  current_ownership_observation: 'Nuvarande ägande, registerbelagt',
  ownership_observation: 'Ägande, registerbelagt',
  historical_predecessor_holding: 'Ägande på historisk föregångare',
  occupancy: 'Boende/bruk',
  tenancy: 'Hyra',
  'köp': 'Köp',
  'överlåtelse': 'Överlåtelse',
  'ägarbyte': 'Ägarbyte',
  'gåva/familjeöverlåtelse': 'Gåva/familjeöverlåtelse',
  'familjeöverlåtelse/tilldelning': 'Familjeöverlåtelse/tilldelning',
  'arv/övertagande': 'Arv/övertagande',
  'avstyckning': 'Avstyckning',
  'avstyckning och överlåtelse': 'Avstyckning och överlåtelse',
  'överlåtelse och avsöndring': 'Överlåtelse och avsöndring',
  'ägostyckning': 'Ägostyckning',
  'storskifte': 'Storskifte',
  'laga skifte': 'Laga skifte',
  'byggstart': 'Byggstart',
  'brukshändelse': 'Bruk/användning',
  'bruk och uthyrning': 'Bruk och uthyrning',
  'exekutiv auktion': 'Exekutiv auktion',
  'misslyckat köpförsök': 'Misslyckat köpförsök',
  'trolig överlåtelse': 'Trolig överlåtelse',
  property_relation: 'Fastighetsrelation',
  'historisk föregångarhändelse': 'Historisk föregångarhändelse',
});

const ROLE_LABELS = Object.freeze({
  'ägare': 'Ägare',
  'lagfaren ägare': 'Lagfaren ägare',
  'samfällt ägande': 'Samfällt ägande',
  'köpare': 'Köpare',
  'säljare': 'Säljare',
  'hyresgäst': 'Hyresgäst',
  'boende/brukare': 'Boende/brukare',
  'brukare': 'Brukare',
  'pensionatsinnehavare/verksamhetsutövare': 'Pensionatsinnehavare/verksamhetsutövare',
  'dödsbo': 'Dödsbo',
});

function timeLabel(time) {
  return time?.original_text || [time?.start_min, time?.end_max].filter(value => value !== undefined && value !== null).join('–') || 'Okänd tid';
}

function yearRange(entry) {
  const values = [entry.time?.start_min, entry.time?.start_max, entry.time?.end_min, entry.time?.end_max].filter(Number.isFinite);
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

function partyLabel(runtime, party) {
  const resolved = runtime.resolveParty(party.party_ref);
  return `${resolved.display_name}${party.role ? ` · ${ROLE_LABELS[party.role] || party.role}` : ''}`;
}

function ownerNames(runtime, propertyId) {
  const owners = runtime.currentOwners(propertyId).map(item => item.resolved.display_name);
  return owners.length ? owners.join(', ') : 'Saknas';
}

function propertySearch(runtime, property) {
  return normalize([
    property.designation,
    property.display_name,
    ...runtime.placeNames(property),
    ownerNames(runtime, property.id),
    ...runtime.timelineFor(property.id).flatMap(entry => [entry.label, entry.note, entry.entry_type, ...entry.parties.map(party => partyLabel(runtime, party))]),
  ].join(' '));
}

function timelineCard(runtime, entry, writable) {
  const people = entry.parties.map(party => partyLabel(runtime, party)).join(', ');
  const heading = people || entry.label || ENTRY_LABELS[entry.entry_type] || entry.entry_type;
  const sources = entry.source_refs?.length || 0;
  return `<article class="v2-timeline-row${entry.needs_review ? ' needs-review' : ''}">
    <time>${escapeHtml(timeLabel(entry.time))}</time>
    <div><b>${escapeHtml(heading)}</b><span>${escapeHtml(ENTRY_LABELS[entry.entry_type] || entry.entry_type)}</span>${entry.note ? `<p>${escapeHtml(entry.note)}</p>` : ''}${entry.needs_review && entry.review_comment ? `<p class="v2-review-note"><b>Se över:</b> ${escapeHtml(entry.review_comment)}</p>` : ''}${sources ? `<small>${sources} ${sources === 1 ? 'källreferens' : 'källreferenser'}</small>` : ''}</div>
    ${writable ? `<button type="button" data-v2-edit-entry="${escapeAttribute(entry.id)}">Ändra</button>` : ''}
  </article>`;
}

function affiliationLabel(role) {
  return role === 'primary_affiliation' ? 'Huvudsaklig fastighetsanknytning'
    : role === 'builder' ? 'Byggare'
      : role === 'building_contact' ? 'Byggkontakt'
        : role;
}

function option(value, label, selected = false) {
  return `<option value="${escapeAttribute(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export class FastigheterV2Controller {
  constructor({ runtime, writer = null, content, drawer, drawerContent, backdrop, statusNode, onSaved } = {}) {
    this.runtime = runtime;
    this.writer = writer;
    this.content = content;
    this.drawer = drawer;
    this.drawerContent = drawerContent;
    this.backdrop = backdrop;
    this.statusNode = statusNode;
    this.onSaved = onSaved;
    this.selectedPropertyId = null;
    this.saving = false;
    this.dialog = null;
  }

  setWriter(writer) {
    this.writer = writer;
    this.render();
    if (this.selectedPropertyId) this.open(this.selectedPropertyId, { updateUrl: false });
  }

  filters() {
    return {
      search: document.querySelector('#search')?.value || '',
      island: document.querySelector('#island-filter')?.value || '',
      review: document.querySelector('#audit-filter')?.value || '',
      from: Number(document.querySelector('#year-from')?.value || Number.NEGATIVE_INFINITY),
      to: Number(document.querySelector('#year-to')?.value || Number.POSITIVE_INFINITY),
    };
  }

  updateIslands() {
    const select = document.querySelector('#island-filter');
    if (!select) return;
    const before = select.value;
    const values = [...new Set(this.runtime.listProperties().flatMap(property => this.runtime.placeNames(property)))].sort((a, b) => a.localeCompare(b, 'sv'));
    select.innerHTML = option('', 'Alla öar') + values.map(value => option(value, value, value === before)).join('');
  }

  visibleProperties() {
    const filters = this.filters();
    const needle = normalize(filters.search);
    return this.runtime.listProperties().filter(property => {
      const places = this.runtime.placeNames(property);
      const timeline = this.runtime.timelineFor(property.id);
      if (filters.island && !places.includes(filters.island)) return false;
      if (filters.review === 'open' && !timeline.some(entry => entry.needs_review)) return false;
      if (needle && !propertySearch(this.runtime, property).includes(needle)) return false;
      if (Number.isFinite(filters.from) || Number.isFinite(filters.to)) {
        const ranges = timeline.map(yearRange).filter(Boolean);
        if (!ranges.some(range => range.max >= filters.from && range.min <= filters.to)) return false;
      }
      return true;
    });
  }

  render() {
    this.updateIslands();
    const rows = this.visibleProperties();
    const writable = Boolean(this.writer);
    document.querySelector('#filter-count').textContent = `${rows.length} av ${this.runtime.listProperties().length} fastigheter`;
    this.content.innerHTML = `<section class="register-view"><div class="register-heading"><div><p class="eyebrow dark">Fastighetsmaster</p><h2>Fastigheter</h2></div><p>${writable ? 'Ändringar sparas direkt som en ny masterrevision.' : 'Verifierad läsvy.'}</p></div>
      <div class="table-shell"><table><thead><tr><th>Fastighet</th><th>Ö/plats</th><th>Nuvarande ägare</th><th>Historik</th><th>Granskning</th></tr></thead><tbody>${rows.map(property => {
        const timeline = this.runtime.timelineFor(property.id);
        const review = timeline.filter(entry => entry.needs_review).length;
        return `<tr><td><button class="property-open" type="button" data-v2-property="${escapeAttribute(property.id)}"><b>${escapeHtml(property.designation)}</b><span>Öppna tidslinje</span></button></td><td>${escapeHtml(this.runtime.placeNames(property).join(' / ') || 'Ej kopplad')}</td><td>${escapeHtml(ownerNames(this.runtime, property.id))}</td><td>${timeline.length} poster</td><td>${review ? `<span class="question-mark">${review} att se över</span>` : '<span class="muted-text">–</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>${rows.length ? '' : '<p class="empty-row">Inga fastigheter matchar filtren.</p>'}</section>`;
  }

  open(propertyId, { updateUrl = true } = {}) {
    const property = this.runtime.getProperty(propertyId);
    if (!property) return;
    this.selectedPropertyId = propertyId;
    const timeline = this.runtime.timelineFor(propertyId);
    const affiliations = this.runtime.affiliationsFor(propertyId);
    this.drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">Fastighet</p><h2>${escapeHtml(property.display_name)}</h2><p>${escapeHtml(this.runtime.placeNames(property).join(' / ') || 'Plats ej angiven')}</p></header>
      <section class="current-snapshot"><div><p class="snapshot-label">Nuvarande ägare</p><p class="snapshot-owners">${escapeHtml(ownerNames(this.runtime, propertyId))}</p></div></section>
      <section class="drawer-section"><div class="section-heading"><div><p class="eyebrow dark">Tidslinje</p><h3>${timeline.length} poster</h3></div>${this.writer ? '<button class="v2-primary" type="button" data-v2-new-entry>Ny händelse</button>' : ''}</div><div class="v2-property-timeline">${timeline.map(entry => timelineCard(this.runtime, entry, Boolean(this.writer))).join('')}</div></section>
      <details class="drawer-fold"><summary>Personanknytningar <span>${affiliations.length}</span></summary><div class="fold-content"><div class="v2-affiliations">${affiliations.map(row => { const person = this.runtime.people.get('people', row.person_ref.entity_id); return `<span><b>${escapeHtml(person?.display_name || row.person_ref.entity_id)}</b><small>${escapeHtml(affiliationLabel(row.role))}</small></span>`; }).join('') || '<p>Inga fristående anknytningar.</p>'}</div></div></details>`;
    this.drawer.setAttribute('aria-hidden', 'false');
    this.backdrop.hidden = false;
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('property', propertyId);
      history.replaceState(null, '', url);
    }
  }

  close() {
    if (this.saving) return;
    this.drawer.setAttribute('aria-hidden', 'true');
    this.backdrop.hidden = true;
    this.drawerContent.innerHTML = '';
    this.selectedPropertyId = null;
    const url = new URL(location.href);
    url.searchParams.delete('property');
    history.replaceState(null, '', url);
  }

  personOptions(reference) {
    const values = [option('', 'Ingen person/part')];
    for (const person of this.runtime.people.list('people').sort((a, b) => a.display_name.localeCompare(b.display_name, 'sv'))) {
      values.push(option(`people|${person.id}`, person.display_name, reference?.master === 'people' && reference.entity_id === person.id));
    }
    for (const party of this.runtime.properties.list('property_parties').sort((a, b) => a.display_name.localeCompare(b.display_name, 'sv'))) {
      values.push(option(`fastigheter|${party.id}`, party.display_name, reference?.master === 'fastigheter' && reference.entity_id === party.id));
    }
    return values.join('');
  }

  roleOptions(role) {
    const roles = [...new Set([...Object.keys(ROLE_LABELS), ...this.runtime.properties.list('timeline_entries').flatMap(entry => entry.parties.map(party => party.role))])].sort((a, b) => (ROLE_LABELS[a] || a).localeCompare(ROLE_LABELS[b] || b, 'sv'));
    return roles.map(value => option(value, ROLE_LABELS[value] || value, value === role)).join('');
  }

  partyRow(party = null) {
    return `<div class="v2-party-row"><select data-v2-party-ref>${this.personOptions(party?.party_ref)}</select><select data-v2-party-role>${option('', 'Välj roll')}${this.roleOptions(party?.role)}</select><button type="button" data-v2-remove-party aria-label="Ta bort part">×</button></div>`;
  }

  openEditor(entry = null) {
    if (!this.writer || !this.selectedPropertyId) return;
    this.dialog?.remove();
    const entryTypes = [...new Set([...Object.keys(ENTRY_LABELS), ...this.runtime.properties.list('timeline_entries').map(row => row.entry_type)])].sort((a, b) => (ENTRY_LABELS[a] || a).localeCompare(ENTRY_LABELS[b] || b, 'sv'));
    const time = entry?.time || { kind: 'unknown', original_text: 'Okänt' };
    const dialog = document.createElement('dialog');
    dialog.className = 'v2-editor';
    dialog.dataset.entryId = entry?.id || `timeline:${crypto.randomUUID()}`;
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow dark">${entry ? 'Tidslinjepost' : 'Ny händelse'}</p><h2>${entry ? 'Ändra uppgiften' : 'Lägg till uppgift'}</h2></div><button type="button" data-v2-close-editor aria-label="Stäng">×</button></header>
      <div class="v2-editor-grid"><label><span>Händelsetyp</span><select data-v2-entry-type required>${entryTypes.map(value => option(value, ENTRY_LABELS[value] || value, value === entry?.entry_type)).join('')}</select></label><label><span>Rubrik</span><input data-v2-label value="${escapeAttribute(entry?.label || '')}" placeholder="Kort beskrivning"></label>
      <label><span>Tidsform</span><select data-v2-time-kind>${option('point', 'År/tidpunkt', time.kind === 'point')}${option('period', 'Period', time.kind === 'period')}${option('observation', 'Belagd/observerad tid', time.kind === 'observation')}${option('unknown', 'Okänd tid', time.kind === 'unknown')}</select></label><label><span>Så tiden ska visas</span><input data-v2-time-text required value="${escapeAttribute(time.original_text || '')}" placeholder="t.ex. 1970-talet"></label>
      <label><span>Start tidigast</span><input data-v2-start-min type="number" min="1600" max="2200" value="${escapeAttribute(time.start_min ?? '')}"></label><label><span>Start senast</span><input data-v2-start-max type="number" min="1600" max="2200" value="${escapeAttribute(time.start_max ?? '')}"></label><label><span>Slut tidigast</span><input data-v2-end-min type="number" min="1600" max="2200" value="${escapeAttribute(time.end_min ?? '')}"></label><label><span>Slut senast</span><input data-v2-end-max type="number" min="1600" max="2200" value="${escapeAttribute(time.end_max ?? '')}"></label>
      <label><span>Belopp</span><input data-v2-amount type="number" step="0.01" value="${escapeAttribute(entry?.amount ?? '')}"></label><label><span>Valuta</span><select data-v2-currency>${option('', 'Ingen')}${option('SEK', 'SEK', entry?.currency === 'SEK')}</select></label><label><span>Areal, hektar</span><input data-v2-area type="number" step="0.0001" value="${escapeAttribute(entry?.area_ha ?? '')}"></label>
      <label class="v2-editor-wide"><span>Not</span><textarea data-v2-note>${escapeHtml(entry?.note || '')}</textarea></label></div>
      <section class="v2-party-editor"><div><h3>Personer/parter</h3><button type="button" data-v2-add-party>Lägg till</button></div><div data-v2-party-rows>${(entry?.parties || []).map(party => this.partyRow(party)).join('')}</div></section>
      <label class="v2-review-check"><input data-v2-needs-review type="checkbox"${entry?.needs_review ? ' checked' : ''}><span>Det finns något jag vill se över senare</span></label><label class="v2-review-comment"><span>Kort granskningsnot</span><input data-v2-review-comment value="${escapeAttribute(entry?.review_comment || '')}" placeholder="Visas bara när rutan ovan är vald"></label>
      <p class="v2-editor-note">Källreferenser och koppling till flera fastigheter bevaras vid redigering. En ny post börjar utan källreferens och kan kompletteras senare.</p><footer><button type="button" data-v2-close-editor>Stäng</button><button class="v2-primary" type="submit">Spara</button></footer></form>`;
    document.body.append(dialog);
    this.dialog = dialog;
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-v2-close-editor]')) dialog.close();
      if (event.target.closest('[data-v2-add-party]')) dialog.querySelector('[data-v2-party-rows]').insertAdjacentHTML('beforeend', this.partyRow());
      if (event.target.closest('[data-v2-remove-party]')) event.target.closest('.v2-party-row').remove();
    });
    dialog.addEventListener('close', () => { if (!this.saving) { dialog.remove(); if (this.dialog === dialog) this.dialog = null; } });
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); this.saveEditor(entry).catch(error => { this.statusNode.textContent = error.message; this.statusNode.className = 'status-error'; }); });
    dialog.showModal();
  }

  numeric(selector) {
    const raw = this.dialog.querySelector(selector).value;
    return raw === '' ? null : Number(raw);
  }

  async saveEditor(existing) {
    if (!this.writer || !this.dialog || this.saving) return;
    const partyRows = [...this.dialog.querySelectorAll('.v2-party-row')].map(row => {
      const value = row.querySelector('[data-v2-party-ref]').value;
      const role = row.querySelector('[data-v2-party-role]').value;
      if (!value && !role) return null;
      if (!value || !role) throw new Error('Varje person/part måste ha både namn och roll.');
      const [master, entityId] = value.split('|');
      return { party_ref: { master, entity_type: master === 'people' ? 'person' : 'property_party', entity_id: entityId }, role };
    }).filter(Boolean);
    const time = {
      kind: this.dialog.querySelector('[data-v2-time-kind]').value,
      original_text: this.dialog.querySelector('[data-v2-time-text]').value.trim(),
    };
    for (const [field, selector] of [['start_min', '[data-v2-start-min]'], ['start_max', '[data-v2-start-max]'], ['end_min', '[data-v2-end-min]'], ['end_max', '[data-v2-end-max]']]) {
      const value = this.numeric(selector);
      if (value !== null) time[field] = value;
    }
    if (!time.original_text) throw new Error('Skriv hur tiden ska visas.');
    const needsReview = this.dialog.querySelector('[data-v2-needs-review]').checked;
    const reviewComment = this.dialog.querySelector('[data-v2-review-comment]').value.trim();
    if (needsReview && !reviewComment) throw new Error('Skriv en kort granskningsnot eller avmarkera rutan.');
    const patch = {
      property_ids: existing?.property_ids || [this.selectedPropertyId],
      entry_type: this.dialog.querySelector('[data-v2-entry-type]').value,
      time,
      parties: partyRows,
      related_properties: existing?.related_properties || [],
      source_refs: existing?.source_refs || [],
      label: this.dialog.querySelector('[data-v2-label]').value.trim() || null,
      note: this.dialog.querySelector('[data-v2-note]').value.trim() || null,
      amount: this.numeric('[data-v2-amount]'),
      currency: this.dialog.querySelector('[data-v2-currency]').value || null,
      area_ha: this.numeric('[data-v2-area]'),
      needs_review: needsReview || null,
      review_comment: needsReview ? reviewComment : null,
    };
    if (existing?.chronology_order !== undefined) patch.chronology_order = existing.chronology_order;
    this.saving = true;
    const buttons = [...this.dialog.querySelectorAll('button,input,select,textarea')];
    buttons.forEach(node => { node.disabled = true; });
    this.statusNode.textContent = 'Sparar en ny Fastighetsrevision…';
    this.statusNode.className = '';
    const dialog = this.dialog;
    try {
      const saved = await this.writer.saveTimelineEntry(dialog.dataset.entryId, patch);
      await this.onSaved?.(saved);
      dialog.close();
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
      this.render();
      this.open(this.selectedPropertyId, { updateUrl: false });
      this.statusNode.textContent = `Sparat · Fastigheter revision ${saved.master.master_revision} · historikkvitto skapat`;
      this.statusNode.className = 'status-ok';
    } finally {
      this.saving = false;
      buttons.forEach(node => { node.disabled = false; });
    }
  }
}

export function createFastigheterV2Controller(options) {
  return new FastigheterV2Controller(options);
}
