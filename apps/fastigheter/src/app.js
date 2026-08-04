import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createBatch,
  exchangeDropboxRefreshToken,
  openSlaktlandskapDB,
  validateOperation,
} from '../../../packages/core/data-layer.js';
import { resolvePartyName } from '../../../packages/core/master-data.js';
import { ReadOnlyMaster } from '../../../packages/core/read-only-master.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_BOOTSTRAP_URL } from './config.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const drawer = $('#property-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/fastigheter/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:fastigheter-full-2026-08-02';
const DATE_FIELDS = ['contract_date', 'possession_date', 'application_date', 'survey_date', 'approval_date', 'date_text'];
const DATE_LABELS = {
  contract_date: 'Köpe-/kontraktsdag', possession_date: 'Tillträde', application_date: 'Ansökan',
  survey_date: 'Förrättning/intyg', approval_date: 'Fastställelse', date_text: 'Datering',
};

let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedPropertyId = null;
let matrikelMaster;
const ui = { search: '', island: '', audit: '', view: 'properties', yearFrom: '', yearTo: '' };

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const slug = value => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post';
const unique = values => [...new Set(values.filter(Boolean))];
const recordList = type => repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const propertyRecords = () => recordList('property').sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true }));
const eventRecords = () => recordList('event');
const holdingRecords = () => recordList('holding');
const observationRecords = () => recordList('observation');
const currentOwnerRecords = () => recordList('current-owner-assessment');
const auditRecords = () => recordList('audit-finding');
const sourceRecords = () => recordList('source').sort((a, b) => a.id.localeCompare(b.id, 'sv'));
const communityRecords = () => recordList('community-link');
const partyRecords = () => recordList('party');
const manualClaimRecords = () => recordList('manual-claim');
const holdingClaimRecords = () => recordList('holding-claim');
const eventClaimRecords = () => recordList('event-claim');
const relationRecords = () => recordList('property-relation');
const eventsFor = id => eventRecords().filter(event => (event.property_ids || []).includes(id));
const holdingsFor = id => holdingRecords().filter(holding => holding.subject_type === 'property' && holding.subject_id === id);
const observationsFor = id => observationRecords().filter(item => item.property_id === id).sort((a, b) => b.observed_on.localeCompare(a.observed_on));
const currentOwnerFor = id => currentOwnerRecords().find(item => item.property_id === id) || null;
const auditFor = id => auditRecords().find(item => item.property_id === id);
const communityFor = id => communityRecords().filter(item => item.property_id === id);
const claimsFor = id => manualClaimRecords().filter(item => item.property_id === id).sort((a, b) => a.order - b.order);
const holdingClaimsFor = id => holdingClaimRecords().filter(item => item.property_id === id).sort((a, b) => (a.order || 0) - (b.order || 0));
const eventClaimsFor = id => eventClaimRecords().filter(item => (item.property_ids || []).includes(id));
const relationsFor = id => relationRecords().filter(item => item.to_property_id === id || item.from_id === id);
const isOfflineError = error => navigator.onLine === false || error instanceof TypeError || /failed to fetch|load failed|networkerror|internetanslutning|network connection/i.test(String(error?.message || error));

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}
function deviceId() {
  const key = 'korpholmen:fastigheter-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = `fastigheter-web-${crypto.randomUUID()}`; localStorage.setItem(key, id); }
  return id;
}
function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }
function eventYear(event) {
  for (const field of DATE_FIELDS) {
    const match = String(event[field] || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
    if (match) return Number(match[1]);
  }
  return event.year_min || event.year_max || null;
}
function eventDate(event) {
  for (const field of ['contract_date', 'possession_date', 'survey_date', 'approval_date', 'date_text']) if (event[field]) return String(event[field]);
  if (event.year_min || event.year_max) return event.year_min === event.year_max ? String(event.year_min) : `${event.year_min || '?'}–${event.year_max || '?'}`;
  return 'Odaterad';
}
function currentOwners(propertyId) {
  const assessment = currentOwnerFor(propertyId);
  if (!assessment) return { names: [], basis: null, reviewedOn: null };
  const parties = new Map(partyRecords().map(party => [party.id, party]));
  return { names: (assessment.owner_party_ids || []).map(id => resolvePartyName(parties.get(id), matrikelMaster) || id), basis: assessment.basis, reviewedOn: assessment.reviewed_on };
}
function propertySearchText(property) {
  return [property.id, property.display_name, property.island, ...currentOwners(property.id).names,
    ...eventsFor(property.id).flatMap(event => [event.label, event.notes]),
    ...eventClaimsFor(property.id).flatMap(event => [event.label, event.notes, event.date_text]),
    ...holdingClaimsFor(property.id).flatMap(claim => [claim.holder_text, claim.role, claim.period_text, claim.raw_text]),
    ...communityFor(property.id).map(link => matrikelMaster?.getEntity('person', link.person_id)?.fields.display_name || link.person_display_name),
    auditFor(property.id)?.summary].join(' ');
}
function filteredProperties() {
  const query = normalize(ui.search);
  return propertyRecords().filter(property => {
    if (ui.island && property.island !== ui.island) return false;
    const audit = auditFor(property.id);
    if (ui.audit === 'important' && audit?.severity !== 'viktig') return false;
    if (ui.audit === 'open' && !/olöst|konflikt|avvikelse/i.test(`${audit?.status} ${audit?.summary}`)) return false;
    if (query && !normalize(propertySearchText(property)).includes(query)) return false;
    if (ui.yearFrom || ui.yearTo) {
      const years = [...eventsFor(property.id), ...eventClaimsFor(property.id)].map(eventYear).filter(Boolean);
      const from = Number(ui.yearFrom || -Infinity); const to = Number(ui.yearTo || Infinity);
      if (!years.some(year => year >= from && year <= to)) return false;
    }
    return true;
  });
}
function auditChip(audit) {
  if (!audit) return '<span class="chip muted">Inte källgranskad</span>';
  return `<span class="chip ${audit.severity === 'viktig' ? 'warn' : ''}">${escapeHtml(audit.status)}</span>`;
}
function propertyCard(property) {
  const owners = currentOwners(property.id); const audit = auditFor(property.id); const events = eventsFor(property.id); const claims = eventClaimsFor(property.id);
  return `<button class="property-card" type="button" data-property-id="${escapeHtml(property.id)}">
    <span class="property-code">${escapeHtml(property.id.replace('Alsvik ', ''))}</span>
    <span class="property-copy"><h3>${escapeHtml(property.display_name || property.id)}</h3>
      <p>${owners.names.length ? escapeHtml(owners.names.join(', ')) : 'Ingen bedömd nuvarande ägare'}</p>
      <span class="chips"><span class="chip">${events.length} belagda · ${claims.length} uppgifter</span><span class="chip">${holdingClaimsFor(property.id).length} kedjeled</span><span class="chip">${communityFor(property.id).length} personkopplingar</span>${auditChip(audit)}</span>
    </span></button>`;
}
function renderProperties() {
  const items = filteredProperties();
  $('#filter-count').textContent = `${items.length} av ${propertyRecords().length} fastigheter`;
  if (!propertyRecords().length) return `<section class="empty"><h2>Ingen privat fastighetsdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta mastern. I källappen kan den låsta startkopian aktiveras.</p></section>`;
  const groups = new Map();
  for (const property of items) { const island = property.island || 'Övrigt och samfälligheter'; if (!groups.has(island)) groups.set(island, []); groups.get(island).push(property); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'sv')).map(([island, properties]) =>
    `<section class="group"><h2>${escapeHtml(island)} <small>(${properties.length})</small></h2><div class="property-grid">${properties.map(propertyCard).join('')}</div></section>`).join('') || '<p>Inga fastigheter matchar filtren.</p>';
}
function renderTimeline() {
  const visible = new Set(filteredProperties().map(property => property.id));
  const verified = eventRecords().filter(event => (event.property_ids || []).some(id => visible.has(id))).map(event => ({ ...event, _kind: 'belagd' }));
  const claims = eventClaimRecords().filter(event => !event.superseded_by_event_id && (event.property_ids || []).some(id => visible.has(id))).map(event => ({ ...event, _kind: 'uppgift' }));
  const events = [...verified, ...claims].sort((a, b) => (eventYear(a) || 9999) - (eventYear(b) || 9999) || eventDate(a).localeCompare(eventDate(b), 'sv'));
  $('#filter-count').textContent = `${verified.length} belagda · ${claims.length} strukturerade uppgifter`;
  return `<section class="timeline"><h2>Kronologisk fastighetshistorik</h2><p class="section-help">Heldragna poster är källbelagda händelser. Streckade poster är strukturerade uppgifter, intervall eller härledda övergångar som ännu inte har samma bevisvärde.</p>${events.map(event => `<article class="timeline-item ${event._kind === 'uppgift' ? 'claim-card' : ''}">
    <time>${escapeHtml(eventDate(event))}</time><div><span class="claim-kind ${event._kind}">${event._kind}</span><h3>${escapeHtml(event.label)}</h3><p>${escapeHtml(event.property_ids.join(', '))}</p>
    <p class="date-roles">${DATE_FIELDS.filter(field => event[field]).map(field => `<span><b>${DATE_LABELS[field]}:</b> ${escapeHtml(event[field])}</span>`).join('')}</p>
    ${event.amount ? `<p>${Number(event.amount).toLocaleString('sv-SE')} ${escapeHtml(event.currency || '')}${event.area_ha ? ` · ${event.area_ha} ha` : ''}</p>` : ''}
    ${event._kind === 'uppgift' ? `<p><small>${escapeHtml(event.verification_status)} · ${escapeHtml(event.certainty)}</small></p>` : ''}</div></article>`).join('') || '<p>Inga daterade händelser matchar.</p>'}</section>`;
}
function renderAudit() {
  const visible = new Set(filteredProperties().map(property => property.id));
  const findings = auditRecords().filter(item => visible.has(item.property_id)).sort((a, b) => (a.severity === 'viktig' ? -1 : 1) - (b.severity === 'viktig' ? -1 : 1));
  $('#filter-count').textContent = `${findings.length} granskade fastigheter`;
  return `<section class="audit-list"><h2>Källkontroll mot senare Lantmäterifynd</h2><p>Registerdatum visas som observationer. Exakta avtals- och förrättningsdatum lagras separat.</p>${findings.map(item => `<button type="button" data-property-id="${escapeHtml(item.property_id)}" class="audit-row"><span>${escapeHtml(item.property_id)}</span><b>${escapeHtml(item.status)}</b><p>${escapeHtml(item.summary)}</p></button>`).join('')}</section>`;
}
function updateFilterOptions() {
  const island = $('#island-filter'); const current = island.value;
  const values = unique(propertyRecords().map(property => property.island)).sort((a, b) => a.localeCompare(b, 'sv'));
  island.innerHTML = '<option value="">Alla öar</option>' + values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  island.value = values.includes(current) ? current : '';
}
function render() {
  updateFilterOptions();
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === ui.view));
  content.innerHTML = ui.view === 'timeline' ? renderTimeline() : ui.view === 'audit' ? renderAudit() : renderProperties();
  if (selectedPropertyId) renderDrawer(selectedPropertyId);
}

function dateRoleList(event) {
  return DATE_FIELDS.filter(field => event[field]).map(field => `<li><b>${DATE_LABELS[field]}:</b> ${escapeHtml(event[field])}</li>`).join('');
}
function claimPeriod(claim) {
  if (claim.period_text) return claim.period_text;
  if (claim.date_text) return claim.date_text;
  const start = claim.start_year || claim.start_year_min; const end = claim.end_year || claim.end_year_max;
  return start || end ? `${start || '?'}–${end || '?'}` : 'odaterat';
}
function renderStructuredHistorySection(holdingClaims, hasUnnormalizedClaims) {
  return `<section class="drawer-section" data-section="history"><h3>Historik</h3><p class="section-help">Samtliga poster ur den manuella tabellen har en roll, tidsperiod, osäkerhetsgrad, källstatus och länk till originaluppgiften. Hyra, boende och verksamhetsdrift hålls skilda från juridiskt ägande.</p>
    <div class="claim-chain">${holdingClaims.map(claim => `<article class="history-claim ${/hyresgäst|boende|brukare|verksamhetsutövare/i.test(claim.role) ? 'role-warning' : ''}"><time>${escapeHtml(claimPeriod(claim))}</time><div><h4>${escapeHtml(claim.holder_text)}</h4><p><b>${escapeHtml(claim.role)}</b> · ${escapeHtml(claim.verification_status)}</p><p><small>${escapeHtml(claim.certainty)} · ${escapeHtml((claim.source_ids || []).join(', '))}</small></p>${claim.source_locators?.length ? `<p><small>${escapeHtml(claim.source_locators.join('; '))}</small></p>` : ''}<details><summary>Originaluppgift</summary><p>${escapeHtml(claim.raw_text)}</p></details></div></article>`).join('') || '<p>Ingen råkedja för fastigheten.</p>'}</div>
    ${hasUnnormalizedClaims ? '<p class="error">En eller flera råposter saknar normalisering.</p>' : ''}
  </section>`;
}
function renderDrawer(id) {
  const property = propertyRecords().find(item => item.id === id);
  if (!property) return closeDrawer();
  const events = eventsFor(id).sort((a, b) => eventDate(a).localeCompare(eventDate(b), 'sv'));
  const observations = observationsFor(id); const holdings = holdingsFor(id); const audit = auditFor(id);
  const current = currentOwners(id);
  const holdingClaims = holdingClaimsFor(id); const eventClaims = eventClaimsFor(id).sort((a, b) => (eventYear(a) || 9999) - (eventYear(b) || 9999));
  const sources = new Map(sourceRecords().map(source => [source.id, source]));
  const parties = new Map(partyRecords().map(party => [party.id, party]));
  const links = communityFor(id);
  drawerContent.innerHTML = `<h2>${escapeHtml(property.display_name || property.id)}</h2><p class="drawer-id">${escapeHtml(property.id)}</p>
    ${renderStructuredHistorySection(holdingClaims, claimsFor(id).some(claim => !claim.normalized))}
    <section class="drawer-section" data-section="identity"><h3>Identitet</h3><div class="edit-grid">
      <label>Namn<input data-property-field="display_name" value="${escapeHtml(property.display_name || '')}"></label>
      <label>Ö/plats<input data-property-field="island" value="${escapeHtml(property.island || '')}"></label>
      <label class="span-2">Kort etikett<input data-property-field="label" value="${escapeHtml(property.label || '')}"></label>
    </div><p><b>Master:</b> Fastighetsregistret · stabilt id från Matrikeln.</p></section>
    <section class="drawer-section"><h3>Källgranskning</h3>${audit ? `<p>${auditChip(audit)}</p><p>${escapeHtml(audit.summary)}</p><p><small>Jämförda källor: ${escapeHtml((audit.compared_source_ids || []).join(', '))}</small></p>` : '<p>Ingen granskningspost.</p>'}</section>
    <section class="drawer-section"><h3>Bäst kända nuvarande ägare</h3>${current.names.length ? `<p><b>${escapeHtml(current.names.join(', '))}</b></p><p class="section-help">${escapeHtml(current.basis || '')}${current.reviewedOn ? ` · granskat ${escapeHtml(current.reviewedOn)}` : ''}</p>` : '<p>Ingen tillräckligt säker nulägesbedömning.</p>'}</section>
    <section class="drawer-section"><h3>Observerade lagfarna ägare</h3><p class="section-help">Historiskt källager. Datumet är när registret lästes, inte automatiskt när förvärvet skedde.</p>
      ${observations.map(item => `<div class="history-row"><time>${escapeHtml(item.observed_on)}</time><div><b>${(item.owner_party_ids || []).map(partyId => escapeHtml(resolvePartyName(parties.get(partyId), matrikelMaster) || partyId)).join(', ') || 'Ägare ej tillgänglig'}</b><br><small>${escapeHtml(item.source_id)}${item.notes ? ` · ${escapeHtml(item.notes)}` : ''}</small></div></div>`).join('') || '<p>Ingen registerobservation.</p>'}
    </section>
    <section class="drawer-section"><h3>Belagda händelser och transaktioner</h3>${events.map(event => `<article class="event-card"><div><span class="claim-kind belagd">belagd</span><time>${escapeHtml(eventDate(event))}</time><h4>${escapeHtml(event.label)}</h4><ul>${dateRoleList(event)}</ul>${event.amount ? `<p><b>${Number(event.amount).toLocaleString('sv-SE')} ${escapeHtml(event.currency || '')}</b>${event.area_ha ? ` · ${event.area_ha} ha` : ''}</p>` : ''}${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ''}<small>${escapeHtml((event.source_ids || []).join(', '))}</small></div><button type="button" data-delete-event="${escapeHtml(event.id)}">Ta bort</button></article>`).join('') || '<p>Inga fullt belagda händelser.</p>'}
      <form id="new-event-form" class="entry-form"><h4>Ny händelse</h4><label>Typ<input name="type" required placeholder="överlåtelse, arv, avstyckning …"></label><label class="span-2">Rubrik<input name="label" required></label><label>Kontraktsdatum<input name="contract_date" type="date"></label><label>Tillträdesdatum<input name="possession_date" type="date"></label><label>Ansökningsdatum<input name="application_date" type="date"></label><label>Fastställelsedatum<input name="approval_date" type="date"></label><label>Belopp (SEK)<input name="amount" inputmode="decimal"></label><label class="span-2">Not<input name="notes"></label><button class="primary" type="submit">Lägg till händelse</button></form>
    </section>
    <section class="drawer-section"><h3>Historiska händelseuppgifter</h3><p class="section-help">Dessa poster är nu fullt strukturerade och sökbara, men kan vara ungefärliga, motstridiga eller härledda ur kedjans ordning.</p>
      ${eventClaims.map(event => `<article class="event-card claim-card"><div><span class="claim-kind uppgift">uppgift</span><time>${escapeHtml(eventDate(event))}</time><h4>${escapeHtml(event.label)}</h4>${event.amount ? `<p><b>${Number(event.amount).toLocaleString('sv-SE')} ${escapeHtml(event.currency || '')}</b></p>` : ''}<p><small>${escapeHtml(event.type)} · ${escapeHtml(event.verification_status)} · ${escapeHtml(event.certainty)}</small></p>${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ''}<small>${escapeHtml((event.source_ids || []).join(', '))}${event.source_locators?.length ? ` · ${escapeHtml(event.source_locators.join('; '))}` : ''}</small></div></article>`).join('') || '<p>Inga händelseuppgifter.</p>'}
    </section>
    <section class="drawer-section"><h3>Innehav och roller</h3>${holdings.map(holding => `<div class="history-row"><time>${escapeHtml(holding.start_date || holding.observed_on || 'odaterat')}</time><div><b>${escapeHtml(resolvePartyName(parties.get(holding.party_id), matrikelMaster) || holding.name || holding.party_id)}</b><br><small>${escapeHtml(holding.role)} · ${escapeHtml(holding.certainty || holding.basis || '')}</small></div></div>`).join('')}
      <form id="new-holding-form" class="entry-form"><h4>Nytt innehav eller bruk</h4><label class="span-2">Person/part<input name="name" required></label><label>Roll<select name="role"><option>ägare</option><option>lagfaren ägare</option><option>hyresgäst</option><option>brukare</option><option>arrendator</option><option>dödsbo</option></select></label><label>Från<input name="start_date" type="date"></label><label>Till<input name="end_date" type="date"></label><label>Observerad<input name="observed_on" type="date"></label><button class="primary" type="submit">Lägg till innehav</button></form>
    </section>
    <section class="drawer-section"><h3>Kopplingar</h3><p>${relationsFor(id).map(relation => escapeHtml(`${relation.from_id} → ${relation.to_property_id}: ${relation.relation} (${relation.certainty})`)).join('<br>') || 'Ingen kadastral relation.'}</p><h4>Fastighetsgemenskap i Matrikeln</h4><p class="section-help">Dessa kopplingar betyder anknytning till fastigheten, inte lagfart.</p><p>${links.map(link => `<a href="../matrikel/?person=${encodeURIComponent(link.person_id)}">${escapeHtml(matrikelMaster?.getEntity('person', link.person_id)?.fields.display_name || link.person_display_name)}</a>`).join(', ') || 'Inga personkopplingar.'}</p></section>
    <section class="drawer-section"><h3>Källor</h3><ul>${unique([...events.flatMap(event => event.source_ids || []), ...eventClaims.flatMap(event => event.source_ids || []), ...holdings.flatMap(holding => holding.source_ids || []), ...holdingClaims.flatMap(holding => holding.source_ids || []), ...(audit?.compared_source_ids || [])]).map(sourceId => `<li><b>${escapeHtml(sourceId)}</b> — ${escapeHtml(sources.get(sourceId)?.label || '')}</li>`).join('')}</ul></section>`;
  drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false;
}
function openDrawer(id) { selectedPropertyId = id; renderDrawer(id); }
function closeDrawer() { selectedPropertyId = null; drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; drawerContent.innerHTML = ''; }
async function syncEdit(action) { await action(); render(); try { await syncNow(); } catch (_) { setStatus('Sparat lokalt · synk kräver åtgärd', 'warning'); } }
async function editProperty(target) { await syncEdit(() => repository.setField('property', selectedPropertyId, target.dataset.propertyField, target.value.trim() || null)); }
async function addEvent(form) {
  const data = Object.fromEntries(new FormData(form));
  const id = `event-user-${slug(data.contract_date || data.approval_date || 'odaterad')}-${crypto.randomUUID().slice(0, 8)}`;
  const fields = { property_ids: [selectedPropertyId], type: data.type.trim(), label: data.label.trim(), source_ids: ['APP-DIREKT'] };
  for (const field of ['contract_date', 'possession_date', 'application_date', 'approval_date', 'notes']) if (data[field]?.trim()) fields[field] = data[field].trim();
  if (data.amount?.trim()) { const amount = Number(data.amount.replace(',', '.')); if (!Number.isFinite(amount)) throw new Error('Beloppet är inte ett tal'); fields.amount = amount; fields.currency = 'SEK'; }
  await syncEdit(() => repository.setFields(Object.entries(fields).map(([field, value]) => ({ entityType: 'event', entityId: id, field, value }))));
}
async function addHolding(form) {
  const data = Object.fromEntries(new FormData(form)); const name = data.name.trim();
  let party = partyRecords().find(item => normalize(item.name) === normalize(name));
  const entries = [];
  if (!party) { party = { id: `party-user-${slug(name)}-${crypto.randomUUID().slice(0, 6)}` }; entries.push(
    { entityType: 'party', entityId: party.id, field: 'name', value: name },
    { entityType: 'party', entityId: party.id, field: 'party_type', value: 'person eller namngrupp' },
    { entityType: 'party', entityId: party.id, field: 'identity_status', value: 'fristående part' }); }
  const id = `holding-user-${slug(selectedPropertyId)}-${crypto.randomUUID().slice(0, 8)}`;
  const fields = { subject_type: 'property', subject_id: selectedPropertyId, party_id: party.id, name, role: data.role, certainty: 'registrerad i appen', basis: 'direktregistrering', source_ids: ['APP-DIREKT'] };
  for (const field of ['start_date', 'end_date', 'observed_on']) if (data[field]) fields[field] = data[field];
  entries.push(...Object.entries(fields).map(([field, value]) => ({ entityType: 'holding', entityId: id, field, value })));
  await syncEdit(() => repository.setFields(entries));
}
async function deleteEvent(id) {
  const event = eventRecords().find(item => item.id === id); if (!event || !confirm(`Ta bort händelsen ”${event.label}”? Historiken bevaras i operationsloggen.`)) return;
  await syncEdit(() => repository.deleteEntity('event', id));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  try { return await navigator.serviceWorker.register('./sw.js', { scope: './' }); }
  catch (error) { console.warn('Appskalet kunde inte uppdateras', error); return null; }
}
async function completeOAuthCallbackIfNeeded() {
  const url = new URL(location.href); if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth(); accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}
async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META); if (!refreshToken || !DROPBOX_CLIENT_ID || navigator.onLine === false) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token; accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token);
  return accessToken;
}
async function uploadBootstrapOps(transport) {
  const pending = await store.getMeta(BOOTSTRAP_META); if (!pending?.pending) return 0;
  const operations = (await store.getAllOps()).filter(op => op.device_id === pending.device_id).sort((a, b) => a.seq - b.seq);
  let uploaded = 0;
  for (let index = 0; index < operations.length; index += 250) { const batch = createBatch(operations.slice(index, index + 250)); await transport.putBatch(batch); uploaded += batch.ops.length; }
  await store.putMeta(BOOTSTRAP_META, { ...pending, pending: false, uploaded_at: new Date().toISOString() }); return uploaded;
}
async function loadMatrikelPeople(token) {
  if (!token) return [];
  const result = await matrikelMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-matrikel-read', opsRoot: '/matrikel/ops', readOnly: true }));
  return result;
}
async function syncNow() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const hasCredential = Boolean(await store.getMeta(TOKEN_META));
    if (navigator.onLine === false) { setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}ändringar sparas lokalt`, 'warning'); return null; }
    const token = await currentAccessToken(); if (!token) { setStatus('Lokalt sparat · Dropbox ej ansluten', 'warning'); connectButton.textContent = 'Anslut Dropbox'; return null; }
    connectButton.textContent = 'Synka Dropbox'; setStatus('Synkar…');
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter', opsRoot: '/fastigheter/ops' });
    const bootstrap = await uploadBootstrapOps(transport); const result = await new SyncEngine({ repository, transport }).syncOnce();
    await loadMatrikelPeople(token).catch(error => console.warn('Matrikelpersoner kunde inte hämtas', error));
    render(); setStatus(`Synkad · ${bootstrap + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok'); return result;
  })().catch(error => { console.error(error); if (isOfflineError(error)) { setStatus('Offline · lokalt sparat · synkas automatiskt', 'warning'); return null; } setStatus(`Åtgärd krävs · ${error.message}`, 'error'); throw error; }).finally(() => { syncPromise = null; });
  return syncPromise;
}
async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return', new URL('fastigheter/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES }); location.assign(attempt.url);
}
async function bootstrapLocal() {
  if (!isSourceTree) throw new Error('Startkopian kan bara aktiveras från källappen');
  const response = await fetch(LOCAL_BOOTSTRAP_URL, { cache: 'no-store' }); if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document = await response.json(); if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Startkopian har fel format');
  document.operations.forEach(validateOperation); await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META, { pending: true, device_id: document.device_id, migration_id: document.migration_id, operations: document.operations.length });
  render(); setStatus('Aktuell källmaster inläst lokalt · anslut Dropbox för uppladdning', 'ok');
}

content.addEventListener('click', event => { const target = event.target.closest('[data-property-id]'); if (target) openDrawer(target.dataset.propertyId); });
backdrop.addEventListener('click', closeDrawer);
drawer.addEventListener('click', event => { if (event.target.closest('[data-action="close"]')) closeDrawer(); const remove = event.target.closest('[data-delete-event]'); if (remove) deleteEvent(remove.dataset.deleteEvent); });
drawer.addEventListener('change', event => { const field = event.target.closest('[data-property-field]'); if (field) editProperty(field); });
drawer.addEventListener('submit', event => { event.preventDefault(); const form = event.target; const action = form.id === 'new-event-form' ? addEvent(form) : form.id === 'new-holding-form' ? addHolding(form) : null; action?.catch(error => setStatus(error.message, 'error')); });
$('#search').addEventListener('input', event => { ui.search = event.target.value; render(); });
$('#island-filter').addEventListener('change', event => { ui.island = event.target.value; render(); });
$('#audit-filter').addEventListener('change', event => { ui.audit = event.target.value; render(); });
$('#year-from').addEventListener('input', event => { ui.yearFrom = event.target.value; render(); });
$('#year-to').addEventListener('input', event => { ui.yearTo = event.target.value; render(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { ui.view = button.dataset.view; render(); }));
connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch(error => setStatus(error.message, 'error')));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => syncNow().catch(() => {})); window.addEventListener('offline', () => syncNow().catch(() => {}));

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB({ name: 'korpholmen-fastigheter' }); store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: deviceId() }).init(); matrikelMaster = await new ReadOnlyMaster({ store, cacheKey: 'matrikel' }).init();
  bootstrapButton.hidden = !isSourceTree; render(); await completeOAuthCallbackIfNeeded(); await syncNow(); await serviceWorkerPromise;
}
init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
