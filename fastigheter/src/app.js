import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createRevisionCache,
  createBatch,
  debounce,
  exchangeDropboxRefreshToken,
  isOfflineError,
  openSlaktlandskapDB,
  registerKorpholmenServiceWorker,
  resolveDeviceId,
  validateOperation,
} from '../core/data-layer.js';
import { GenerationCutoverGuard } from '../core/generation-cutover.js';
import { PeopleMembershipMaster } from '../core/people-membership-master.js';
import { resolvePartyName } from '../core/master-data.js';
import { ReadOnlyMaster } from '../core/read-only-master.js';
import { HttpReadTransport } from '../core/sync/http-read-transport.js';
import {
  buildClaimChain,
  currentClaimMatchesNames,
  isUncertain,
  itemSortYear,
  roleLabel,
  sourcePeriod,
} from './timeline-model.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, KARTDATA_BOOTSTRAP_URL, LOCAL_BOOTSTRAP_URLS } from './config.js';
import { createFastigheterActiveRuntime } from './fastigheter-runtime.js?v=2026-08-15-fastigheter-v2-preview-1';
import { createFastigheterV2Controller } from './fastigheter-v2-ui.js?v=2026-08-15-fastigheter-v2-preview-1';
import { createFastigheterWriter } from './fastigheter-writer.js?v=2026-08-15-fastigheter-v2-preview-1';
import { initPropertyMasterComparison } from './master-compare.js';

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
const BOOTSTRAP_META = 'bootstrap:fastigheter-current';
const DATE_FIELDS = ['contract_date', 'possession_date', 'application_date', 'survey_date', 'approval_date', 'date_text'];
const HIDDEN_PUBLIC_SOURCES = new Set(['APP-DIREKT', 'BIO-SIMON', 'FAST-1', 'FAST-2', 'MATR-EXCEL-2026', 'NOT-INTFAKTA']);
const isMasterComparison = new URL(location.href).searchParams.get('propertymaster') === 'compare';

let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedPropertyId = null;
let matrikelMaster;
let kartdataMaster;
let returnFocus = null;
let fastigheterV2Mode = false;
let fastigheterV2Runtime = null;
let fastigheterV2Writer = null;
let fastigheterV2Controller = null;
const ui = { search: '', island: '', audit: '', yearFrom: '', yearTo: '' };
const viewCache = createRevisionCache(() => `${repository?.revision || 0}:${matrikelMaster?.revision || 0}:${kartdataMaster?.revision || 0}`);

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const unique = values => [...new Set(values.filter(Boolean))];
const recordList = type => viewCache(`records:${type}`, () => repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields })));
const propertyRecords = () => viewCache('properties', () => [...recordList('property')].sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true })));
const eventRecords = () => recordList('event');
const holdingRecords = () => recordList('holding');
const currentOwnerRecords = () => recordList('current-owner-assessment');
const auditRecords = () => recordList('audit-finding');
const sourceRecords = () => recordList('source');
const communityRecords = () => recordList('community-link');
const partyRecords = () => recordList('party');
const holdingClaimRecords = () => recordList('holding-claim');
const eventClaimRecords = () => recordList('event-claim');
const relationRecords = () => recordList('property-relation');
const historicalUnitRecords = () => recordList('historical-unit');
const eventsFor = id => eventRecords().filter(event => (event.property_ids || []).includes(id));
const currentOwnerFor = id => currentOwnerRecords().find(item => item.property_id === id) || null;
const auditFor = id => auditRecords().find(item => item.property_id === id) || null;
const communityFor = id => communityRecords().filter(item => item.property_id === id);
const holdingClaimsFor = id => holdingClaimRecords().filter(item => item.property_id === id).sort((a, b) => (a.order || 0) - (b.order || 0));
const eventClaimsFor = id => eventClaimRecords().filter(item => (item.property_ids || []).includes(id));
const relationsFor = id => relationRecords().filter(item => item.to_property_id === id || item.from_id === id);

function kartdataRows(type) {
  return kartdataMaster?.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields })) || [];
}

function propertyIslandName(property) {
  const entryIds = new Set(kartdataRows('data-entry-property-link').filter(link => link.property_id === property.id).map(link => link.entry_id));
  const islandIds = unique(kartdataRows('data-entry-island-link').filter(link => entryIds.has(link.entry_id)).map(link => link.island_id));
  const placeRows = kartdataRows('place').filter(place => place.subtype === 'ö');
  const places = new Map(placeRows.map(place => [place.id, place.preferred_name]));
  const names = unique(islandIds.map(id => places.get(id)));
  if (names.length) return names.join(' / ');
  return placeRows.length ? 'Ej kopplad' : property.island || 'Ej kopplad';
}

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

const deviceId = () => resolveDeviceId({ store, key: 'korpholmen:fastigheter-device-id', prefix: 'fastigheter-web-' });

function generationOneTransport(token) {
  const markerTransport = new DropboxTransport({
    accessToken: token,
    id: 'dropbox-fastigheter-cutover-read',
    opsRoot: '/fastigheter/ops',
    readOnly: true,
  });
  const guard = new GenerationCutoverGuard({ app: 'fastigheter', transport: markerTransport, store });
  return new DropboxTransport({
    accessToken: token,
    id: 'dropbox-fastigheter',
    opsRoot: '/fastigheter/ops',
    writeGuard: context => guard.assertGeneration1Writable(context),
  });
}

function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }

function eventYear(event) {
  for (const field of DATE_FIELDS) {
    const match = String(event[field] || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
    if (match) return Number(match[1]);
  }
  return Number(event.year_min || event.year_max) || null;
}

function eventDate(event) {
  for (const field of ['contract_date', 'possession_date', 'survey_date', 'approval_date', 'date_text']) if (event[field]) return String(event[field]);
  if (event.year_min || event.year_max) return event.year_min === event.year_max ? String(event.year_min) : `${event.year_min || '?'}–${event.year_max || '?'}`;
  return 'Odaterad';
}

function partyMap() { return new Map(partyRecords().map(party => [party.id, party])); }

function resolvedParty(partyId, fallback = null) {
  const party = partyMap().get(partyId);
  const name = party ? resolvePartyName(party, matrikelMaster) || party.name || fallback || partyId : fallback || partyId;
  return { party, name };
}

function personLink(name, personId, className = '') {
  if (!personId) return `<span class="${className}">${escapeHtml(name)}</span>`;
  return `<a class="${className}" href="../personer-familjer/?person=${encodeURIComponent(personId)}">${escapeHtml(name)}</a>`;
}

function currentOwners(propertyId) {
  const assessment = currentOwnerFor(propertyId);
  if (!assessment) return { owners: [], state: 'missing', stateLabel: 'Saknas' };
  const parties = partyMap();
  const owners = (assessment.owner_party_ids || []).map(id => {
    const party = parties.get(id);
    return { id, personId: party?.person_id || null, name: resolvePartyName(party, matrikelMaster) || party?.name || id };
  });
  const confirmationSources = new Set(['FAST-1', 'FAST-2', 'BIO-SIMON', 'APP-DIREKT', 'MUNTLIG-ANN-BONNERSTIG-2021']);
  const confirmed = owners.length > 0 && (assessment.source_ids || []).some(id => confirmationSources.has(id));
  return {
    owners,
    state: confirmed ? 'confirmed' : owners.length ? 'provisional' : 'missing',
    stateLabel: confirmed ? 'Bekräftad' : owners.length ? 'Behöver bekräftas' : 'Saknas',
  };
}

function cleanHolder(value) {
  return String(value || '')
    .replace(/\s*\((?:hyrde|observerade)[^)]*\)\s*$/i, '')
    .replace(/\s*\((?:[-–?0-9Xx ./]+)\)\??\s*$/i, '')
    .trim();
}

function claimMatchesCurrent(claim, current) {
  const party = partyMap().get(claim?.party_id);
  return current.owners.some(owner => owner.id === claim?.party_id)
    || Boolean(party?.person_id && current.owners.some(owner => owner.personId === party.person_id))
    || currentClaimMatchesNames(claim, current.owners.map(owner => owner.name));
}

function historyYears(propertyId) {
  return [...holdingClaimsFor(propertyId).map(itemSortYear), ...eventsFor(propertyId).map(eventYear), ...eventClaimsFor(propertyId).map(eventYear)].filter(Boolean);
}

function propertySearchText(property) {
  return [
    property.id, propertyIslandName(property),
    ...currentOwners(property.id).owners.map(owner => owner.name),
    ...holdingClaimsFor(property.id).flatMap(claim => [claim.holder_text, claim.role, claim.period_text, claim.raw_text]),
    ...eventsFor(property.id).flatMap(event => [event.label, event.notes]),
    ...eventClaimsFor(property.id).flatMap(event => [event.label, event.notes, event.date_text]),
    ...communityFor(property.id).map(link => matrikelMaster?.getEntity('person', link.person_id)?.fields.display_name || link.person_display_name),
    auditFor(property.id)?.summary,
  ].join(' ');
}

function hasOpenQuestion(propertyId) {
  const audit = auditFor(propertyId);
  return Boolean(audit && (/olöst|konflikt|avvikelse|saknas|okänd|oklart/i.test(`${audit.status} ${audit.summary}`) || audit.severity === 'viktig'));
}

function filteredProperties() {
  const query = normalize(ui.search);
  return propertyRecords().filter(property => {
    if (ui.island && propertyIslandName(property) !== ui.island) return false;
    if (ui.audit === 'open' && !hasOpenQuestion(property.id)) return false;
    if (query && !viewCache(`property-search:${property.id}`, () => normalize(propertySearchText(property))).includes(query)) return false;
    if (ui.yearFrom || ui.yearTo) {
      const years = historyYears(property.id);
      const from = Number(ui.yearFrom || -Infinity);
      const to = Number(ui.yearTo || Infinity);
      if (!years.some(year => year >= from && year <= to)) return false;
    }
    return true;
  });
}

function historyLabel(propertyId) {
  const claims = holdingClaimsFor(propertyId).length;
  const events = eventsFor(propertyId).length + eventClaimsFor(propertyId).filter(item => !item.superseded_by_event_id && !item.from_claim_id).length;
  return `${claims} kedjeled · ${events} ${events === 1 ? 'händelse' : 'händelser'}`;
}

function renderOverview() {
  const items = filteredProperties();
  $('#filter-count').textContent = `${items.length} av ${propertyRecords().length} fastigheter`;
  if (!propertyRecords().length) return `<section class="empty"><h2>Ingen privat fastighetsdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta mastern. I källappen kan den låsta startkopian aktiveras.</p></section>`;
  const rows = items.map(property => {
    const owners = currentOwners(property.id);
    const ownerHtml = owners.owners.length ? owners.owners.map(owner => personLink(owner.name, owner.personId)).join(', ') : '<span class="muted-text">Saknas</span>';
    return `<tr>
      <td><button class="property-open" type="button" data-property-id="${escapeHtml(property.id)}"><b>${escapeHtml(property.id)}</b><span>Öppna tidslinje</span></button></td>
      <td>${escapeHtml(propertyIslandName(property))}</td>
      <td>${ownerHtml}</td>
      <td><span class="state ${owners.state}">${owners.stateLabel}</span></td>
      <td>${escapeHtml(historyLabel(property.id))}</td>
      <td>${hasOpenQuestion(property.id) ? '<span class="question-mark">Öppen fråga</span>' : '<span class="muted-text">–</span>'}</td>
    </tr>`;
  }).join('');
  return `<section class="register-view"><div class="register-heading"><div><p class="eyebrow dark">Fastighetsregister</p><h2>Nuvarande läge och kartlagd historik</h2></div><p>Öppna en fastighet för dess tidslinje.</p></div>
    <div class="table-shell"><table><thead><tr><th>Fastighet</th><th>Ö</th><th>Nuvarande ägare</th><th>Nuläge</th><th>Historik</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${items.length ? '' : '<p class="empty-row">Inga fastigheter matchar filtren.</p>'}
  </section>`;
}

function updateFilterOptions() {
  if (fastigheterV2Mode) return;
  const island = $('#island-filter');
  const current = island.value;
  const values = unique(propertyRecords().map(propertyIslandName)).sort((a, b) => a.localeCompare(b, 'sv'));
  island.innerHTML = '<option value="">Alla öar</option>' + values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  island.value = values.includes(current) ? current : '';
}

function render() {
  if (fastigheterV2Mode) return fastigheterV2Controller?.render();
  updateFilterOptions();
  content.innerHTML = renderOverview();
  if (selectedPropertyId) renderDrawer(selectedPropertyId);
}

function claimCard(claim) {
  const { party, name } = resolvedParty(claim.party_id, cleanHolder(claim.holder_text));
  const displayName = cleanHolder(claim.holder_text) || name;
  const personName = party?.person_id ? resolvePartyName(party, matrikelMaster) || displayName : displayName;
  return `<details class="timeline-card ${claim.uncertain ? 'uncertain' : ''}" data-fact-id="${escapeHtml(claim.id)}">
    <summary><time>${escapeHtml(claim.period_label)}</time><span class="timeline-person">${personLink(personName, party?.person_id)}</span><span class="timeline-role">${escapeHtml(claim.role_label)}</span></summary>
    <div class="timeline-detail">${claim.derived_end ? '<p>Slutet är en visning fram till nästa kartlagda uppgift, inte ett separat källbelagt slutdatum.</p>' : ''}${claim.unverified ? '<p>Uppgiften behöver fortfarande ett fristående källbelägg.</p>' : claim.uncertain ? '<p>Perioden eller rollen är osäker.</p>' : ''}${claim.raw_text ? `<p><b>Ursprunglig formulering:</b> ${escapeHtml(claim.raw_text)}</p>` : ''}</div>
  </details>`;
}

function eventMarker(event) {
  const uncertain = isUncertain(event.record) || (event.kind === 'claim' && !/belagd/i.test(event.record.verification_status || ''));
  return `<details class="timeline-event ${uncertain ? 'uncertain' : ''}"><summary><time>${escapeHtml(event.date)}</time><span>${escapeHtml(event.label)}</span></summary>
    <div class="timeline-detail"><p>${escapeHtml(event.type || 'Historisk händelse')}${event.record.amount ? ` · ${Number(event.record.amount).toLocaleString('sv-SE')} ${escapeHtml(event.record.currency || 'kr')}` : ''}</p>${uncertain ? '<p>Händelsen eller dateringen behöver fortsatt kontroll.</p>' : ''}${event.record.notes ? `<p>${escapeHtml(event.record.notes)}</p>` : ''}</div></details>`;
}

function predecessorCards(propertyId) {
  const unitMap = new Map(historicalUnitRecords().map(unit => [unit.id, unit]));
  const unitRelations = relationsFor(propertyId).filter(relation => relation.to_property_id === propertyId && relation.from_type === 'historical-unit');
  const holdings = holdingRecords();
  return unitRelations.flatMap(relation => {
    const unit = unitMap.get(relation.from_id);
    return holdings.filter(holding => holding.subject_type === 'historical-unit' && holding.subject_id === relation.from_id).map(holding => ({
      id: holding.id,
      holder_text: holding.name,
      party_id: holding.party_id,
      role: holding.role,
      period_label: sourcePeriod({ start_year: String(holding.start_date || '').slice(0, 4), end_year: String(holding.end_date || '').slice(0, 4) }),
      role_label: roleLabel(holding.role, holding.name),
      uncertain: isUncertain(holding),
      derived_end: false,
      raw_text: unit ? `Ägare till föregångaren ${unit.display_name}.` : 'Ägare till historisk föregångare.',
      sort_year: Number(String(holding.start_date || '').slice(0, 4)) || null,
      source_ids: holding.source_ids,
    }));
  });
}

function timelineMarkers(propertyId) {
  const verified = eventsFor(propertyId).map(record => ({ id: record.id, record, kind: 'event', label: record.label, type: record.type, date: eventDate(record), year: eventYear(record) }));
  const claims = eventClaimsFor(propertyId)
    .filter(record => !record.superseded_by_event_id && !record.from_claim_id && !record.to_claim_id)
    .map(record => ({ id: record.id, record, kind: 'claim', label: record.label, type: record.type, date: eventDate(record), year: eventYear(record) }));
  return [...verified, ...claims].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.date.localeCompare(b.date, 'sv'));
}

function renderPropertyTimeline(propertyId) {
  const current = currentOwners(propertyId);
  let chain = buildClaimChain(holdingClaimsFor(propertyId));
  if (chain.length && claimMatchesCurrent(chain.at(-1), current)) chain = chain.slice(0, -1);
  const predecessors = predecessorCards(propertyId);
  const predecessorYears = new Set(predecessors.map(item => item.sort_year).filter(Boolean));
  chain = chain.filter(claim => !predecessorYears.has(itemSortYear(claim)));
  const markers = timelineMarkers(propertyId);
  const entries = [];
  let markerIndex = 0;
  const sortedPredecessors = [...predecessors].sort((a, b) => (a.sort_year || 9999) - (b.sort_year || 9999));
  for (const claim of chain) {
    const claimYear = itemSortYear(claim);
    while (markerIndex < markers.length && claimYear && markers[markerIndex].year && markers[markerIndex].year <= claimYear) entries.push({ type: 'event', value: markers[markerIndex++] });
    while (sortedPredecessors.length && claimYear && sortedPredecessors[0].sort_year && sortedPredecessors[0].sort_year <= claimYear) entries.push({ type: 'claim', value: sortedPredecessors.shift() });
    entries.push({ type: 'claim', value: claim });
  }
  while (sortedPredecessors.length) entries.push({ type: 'claim', value: sortedPredecessors.shift() });
  while (markerIndex < markers.length) entries.push({ type: 'event', value: markers[markerIndex++] });
  if (current.owners.length) entries.push({ type: 'current', value: current });
  return `<section class="drawer-section timeline-section"><div class="section-heading"><div><p class="eyebrow dark">Kedjeordning</p><h3>Tidslinje</h3></div><p>Korten visar bara period, person och roll.</p></div>
    <div class="property-timeline">${entries.map(entry => {
      if (entry.type === 'claim') return claimCard(entry.value);
      if (entry.type === 'event') return eventMarker(entry.value);
      return `<div class="timeline-card current"><div class="current-label">Nuläge</div><time>Nu</time><span class="timeline-person">${entry.value.owners.map(owner => personLink(owner.name, owner.personId)).join(' · ')}</span><span class="timeline-role">${entry.value.state === 'confirmed' ? 'Ägare' : 'Bäst kända ägare · behöver bekräftas'}</span></div>`;
    }).join('') || '<p>Ingen tidslinje är kartlagd ännu.</p>'}</div>
  </section>`;
}

function humanLocator(locator) {
  const value = String(locator || '').trim();
  if (!value) return null;
  if (/Fotograferat bokutdrag|Böving.*(?:s\.|sida)|TRY-BOVING-UTDRAG/i.test(value)) return 'Fotograferat bokutdrag, troligen Lena Böving, s. 69–73';
  if (/Från tid till annan/i.test(value)) return 'Hans Lundin, Från tid till annan (boksida behöver fastställas)';
  if (/TRY-HEDSTROM/i.test(value)) return 'Henrik Pederbys intervju med Bibbi Hedström, gjord 1989 och utgiven 1990';
  if (/Ann Bonnerstig/i.test(value)) return 'Muntlig uppgift från Ann Bonnerstig, dokumenterad 2021';
  if (/Janne Camnert/i.test(value)) return 'Muntlig uppgift från Janne Camnert (datum behöver fastställas)';
  if (/Per-Ove Pettersson/i.test(value)) return 'Muntlig uppgift från Per-Ove Pettersson (datum behöver fastställas)';
  if (/INT-STARR2/i.test(value)) return `Starrholmenintervjun 2020, tidskod ${value.replace(/^.*?INT-STARR2\s*/i, '')}`;
  if (/INT-STARR1/i.test(value)) return `Starrholmenintervjun 2020, tidskod ${value.replace(/^.*?INT-STARR1\s*/i, '')}`;
  return value.replace(/\.md(?::\d+(?:[–-]\d+)?)?/gi, '').replace(/\s*[–-]\s*(?:renskrift|avskrift|transkription)$/i, '').trim();
}

function publicCitations(record, sources) {
  const sourceIds = unique(record.source_ids || (record.source_id ? [record.source_id] : []));
  const locators = unique((record.source_locators || []).flatMap(locator => String(locator).split(';')).map(humanLocator))
    .filter(locator => locator && !/^(?:BIO-SIMON|NOT-|FAST-\d|APP-DIREKT|MATR-EXCEL)/i.test(locator));
  const citations = [...locators];
  for (const sourceId of sourceIds) {
    if (HIDDEN_PUBLIC_SOURCES.has(sourceId) || sourceId.startsWith('NOT-')) continue;
    const source = sources.get(sourceId);
    if (!source) continue;
    let label = source.label;
    if (sourceId === 'TRY-LUNDIN') label = 'Hans Lundin, Från tid till annan (boksida behöver fastställas)';
    if (sourceId === 'TRY-HEDSTROM') label = 'Henrik Pederbys intervju med Bibbi Hedström, gjord 1989 och utgiven 1990';
    if (sourceId === 'TRY-BOVING-UTDRAG') label = 'Fotograferat bokutdrag, troligen Lena Böving, s. 69–73';
    if (sourceId === 'TRY-BOVING-2003') label = 'Lena Böving, Är mamma lik sin mamma (2003)';
    if (sourceId === 'TRY-BOVING-2019') label = 'Lena Böving, Släkten följa släktens gång (2019)';
    if (sourceId === 'WEBB-MINNEN' && locators.length) continue;
    if ((sourceId === 'INT-STARR1' || sourceId === 'INT-STARR2') && locators.some(item => /Starrholmenintervjun/i.test(item))) continue;
    if (label) citations.push(label);
  }
  return unique(citations);
}

function researchItems(propertyId) {
  const sources = new Map(sourceRecords().map(source => [source.id, source]));
  const current = currentOwners(propertyId);
  let claims = [...holdingClaimsFor(propertyId)].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (claims.length && claimMatchesCurrent(claims.at(-1), current)) claims = claims.slice(0, -1);
  const claimItems = claims.map(claim => ({ label: `${sourcePeriod(claim)} · ${cleanHolder(claim.holder_text)} · ${roleLabel(claim.role, claim.holder_text)}`, record: claim }));
  const eventItems = [...eventsFor(propertyId), ...eventClaimsFor(propertyId).filter(item => !item.superseded_by_event_id && !item.from_claim_id)].map(event => ({ label: `${eventDate(event)} · ${event.label}`, record: event }));
  const relationItems = relationsFor(propertyId).map(relation => ({ label: `${relation.from_id} → ${relation.to_property_id} · ${relation.relation}`, record: relation }));
  return [...claimItems, ...eventItems, ...relationItems].map(item => ({ ...item, citations: publicCitations(item.record, sources) }));
}

function renderResearch(propertyId) {
  const items = researchItems(propertyId);
  return `<details class="drawer-fold research-fold"><summary>Källforskning och historiska belägg <span>${items.length}</span></summary><div class="fold-content"><p>Nutida fastighetsregister, bekräftelsen av dagens ägare och interna arbetskoder visas inte här.</p><ul class="research-list">${items.map(item => `<li><b>${escapeHtml(item.label)}</b>${item.citations.length ? `<span>${item.citations.map(escapeHtml).join(' · ')}</span>` : '<span>Ursprungskällan har ännu inte kunnat identifieras.</span>'}</li>`).join('')}</ul></div></details>`;
}

function renderCommunity(propertyId) {
  const links = communityFor(propertyId);
  return `<details class="drawer-fold"><summary>Personer med anknytning till fastigheten <span>${links.length}</span></summary><div class="fold-content"><p>Visar Matrikelns huvudsakliga eller senast kända fastighetsanknytning. Det är inte en boendehistorik eller ett ägarbevis.</p><div class="people-list">${links.map(link => {
    const person = matrikelMaster?.getEntity('person', link.person_id)?.fields;
    return personLink(person?.display_name || link.person_display_name || link.person_id, link.person_id);
  }).join('') || '<span>Inga personkopplingar.</span>'}</div></div></details>`;
}

function renderRelations(propertyId) {
  const relations = relationsFor(propertyId);
  if (!relations.length) return '';
  return `<details class="drawer-fold"><summary>Fastighetsbildning och föregångare <span>${relations.length}</span></summary><div class="fold-content"><ul>${relations.map(relation => `<li>${escapeHtml(relation.from_id)} → ${escapeHtml(relation.to_property_id)}: ${escapeHtml(relation.relation)}</li>`).join('')}</ul></div></details>`;
}

function renderOpenQuestions(propertyId) {
  const audit = auditFor(propertyId);
  if (!audit || !hasOpenQuestion(propertyId)) return '';
  return `<details class="drawer-fold question-fold"><summary>Öppna frågor</summary><div class="fold-content"><p>${escapeHtml(audit.summary)}</p></div></details>`;
}

function renderDrawer(id) {
  const property = propertyRecords().find(item => item.id === id);
  if (!property) return closeDrawer();
  const current = currentOwners(id);
  drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">Fastighet</p><h2>${escapeHtml(property.id)}</h2><p>${escapeHtml(propertyIslandName(property))}</p></header>
    <section class="current-snapshot"><div><p class="snapshot-label">Nuvarande ägare</p><p class="snapshot-owners">${current.owners.length ? current.owners.map(owner => personLink(owner.name, owner.personId)).join(' · ') : 'Saknas'}</p></div><span class="state ${current.state}">${current.stateLabel}</span></section>
    ${renderPropertyTimeline(id)}
    <section class="drawer-lower">${renderRelations(id)}${renderOpenQuestions(id)}${renderCommunity(id)}${renderResearch(id)}</section>`;
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.hidden = false;
}

function setPropertyInUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('property', id); else url.searchParams.delete('property');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function openDrawer(id, { updateUrl = true, focusTarget = null } = {}) {
  if (fastigheterV2Mode) return fastigheterV2Controller?.open(id, { updateUrl });
  selectedPropertyId = id;
  returnFocus = focusTarget || document.activeElement;
  renderDrawer(id);
  if (updateUrl) setPropertyInUrl(id);
  drawer.querySelector('.drawer-close')?.focus();
}

function closeDrawer() {
  if (fastigheterV2Mode) return fastigheterV2Controller?.close();
  selectedPropertyId = null;
  drawer.setAttribute('aria-hidden', 'true');
  backdrop.hidden = true;
  drawerContent.innerHTML = '';
  setPropertyInUrl(null);
  returnFocus?.focus?.();
  returnFocus = null;
}

async function registerServiceWorker() {
  try { return await registerKorpholmenServiceWorker({ sourceTree: isSourceTree }); }
  catch (error) { console.warn('Appskalet kunde inte uppdateras', error); return null; }
}

async function completeOAuthCallbackIfNeeded() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth();
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META);
  if (!refreshToken || !DROPBOX_CLIENT_ID || navigator.onLine === false) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token);
  return accessToken;
}

async function uploadBootstrapOps(transport) {
  const pending = await store.getMeta(BOOTSTRAP_META);
  if (!pending?.pending) return 0;
  const ids = new Set(pending.device_ids || (pending.device_id ? [pending.device_id] : []));
  const operations = (await store.getAllOps()).filter(op => ids.has(op.device_id)).sort((a, b) => a.device_id.localeCompare(b.device_id) || a.seq - b.seq);
  let uploaded = 0;
  for (let index = 0; index < operations.length; index += 250) {
    const slice = operations.slice(index, index + 250);
    const groups = new Map();
    for (const operation of slice) { if (!groups.has(operation.device_id)) groups.set(operation.device_id, []); groups.get(operation.device_id).push(operation); }
    for (const group of groups.values()) { const batch = createBatch(group); await transport.putBatch(batch); uploaded += batch.ops.length; }
  }
  await store.putMeta(BOOTSTRAP_META, { ...pending, pending: false, uploaded_at: new Date().toISOString() });
  return uploaded;
}

async function loadReferenceMasters(token) {
  if (!token) return [];
  return Promise.all([
    matrikelMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-people-membership-read', opsRoot: '/personer-familjer/ops', readOnly: true })),
    kartdataMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-kartdata-read', opsRoot: '/kartdata/ops', readOnly: true })),
  ]);
}

async function syncNow() {
  if (fastigheterV2Mode) return syncFastigheterV2();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const hasCredential = Boolean(await store.getMeta(TOKEN_META));
    if (navigator.onLine === false) { setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}lokal data visas`, 'warning'); return null; }
    const token = await currentAccessToken();
    if (!token) { setStatus('Lokalt läsläge · Dropbox ej ansluten', 'warning'); connectButton.textContent = 'Anslut Dropbox'; return null; }
    connectButton.textContent = 'Synka Dropbox';
    setStatus('Synkar…');
    const transport = generationOneTransport(token);
    const bootstrap = await uploadBootstrapOps(transport);
    const result = await new SyncEngine({ repository, transport }).syncOnce();
    await loadReferenceMasters(token).catch(error => console.warn('Person-, medlems- eller Kartdatareferenser kunde inte hämtas; lokal cache används', error));
    render();
    setStatus(`Synkad · ${bootstrap + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok');
    return result;
  })().catch(error => {
    console.error(error);
    if (isOfflineError(error)) { setStatus('Offline · lokal data visas', 'warning'); return null; }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return', new URL('fastigheter/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES });
  location.assign(attempt.url);
}

async function bootstrapLocal() {
  if (!isSourceTree) throw new Error('Startkopian kan bara aktiveras från källappen');
  const documents = [];
  for (const url of LOCAL_BOOTSTRAP_URLS) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
    const document = await response.json();
    if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Startkopian har fel format');
    document.operations.forEach(validateOperation);
    documents.push(document);
  }
  const operations = documents.flatMap(document => document.operations);
  await repository.applyRemoteOps(operations);
  const kartdataResponse = await fetch(KARTDATA_BOOTSTRAP_URL, { cache: 'no-store' });
  if (!kartdataResponse.ok) throw new Error(`Kartdatas ömaster kunde inte läsas (${kartdataResponse.status})`);
  const kartdataDocument = await kartdataResponse.json();
  if (kartdataDocument.operations_version !== 1 || !Array.isArray(kartdataDocument.operations)) throw new Error('Kartdatas ömaster har fel format');
  await kartdataMaster.applyOperations(kartdataDocument.operations, { source: 'kartdata-local-bootstrap' });
  await store.putMeta(BOOTSTRAP_META, {
    pending: true,
    device_ids: unique(documents.map(document => document.device_id)),
    migration_ids: unique(documents.map(document => document.migration_id)),
    operations: operations.length,
  });
  render();
  setStatus('Aktuell lokal master inläst · anslut Dropbox för synk', 'ok');
}

function fastigheterV2WriteTransport(token) {
  const root = '/fastigheter-generation2';
  return new DropboxTransport({
    accessToken: token,
    id: 'dropbox-fastigheter-generation2-write',
    opsRoot: `${root}/ops`,
    writeGuard: ({ path }) => {
      if (path !== root && !path.startsWith(`${root}/`)) throw new Error('Fastighetswritern försökte skriva utanför sin egen namnrymd');
    },
  });
}

async function syncFastigheterV2() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    let localTransport = null;
    if (isSourceTree) {
      try {
        const response = await fetch('/fastigheter-generation2/active.json', { method: 'HEAD', cache: 'no-store' });
        if (response.ok) localTransport = new HttpReadTransport();
      } catch { /* Dropbox eller cache används i stället. */ }
    }
    const token = localTransport ? null : await currentAccessToken();
    if (!localTransport && !token) {
      fastigheterV2Writer = null;
      fastigheterV2Controller?.setWriter(null);
      if (fastigheterV2Runtime.hasData()) {
        setStatus('Offline · senast verifierade Fastigheter V2 visas', 'warning');
        return null;
      }
      setStatus('Anslut Dropbox för att läsa Fastigheter V2', 'warning');
      return null;
    }
    setStatus('Läser Fastigheter V2, Personer och Kartdata…');
    const readTransport = localTransport || new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-generation2-read', opsRoot: '/fastigheter-generation2/ops', readOnly: true });
    const result = await fastigheterV2Runtime.sync(readTransport);
    fastigheterV2Writer = result.writable && token ? createFastigheterWriter({ transport: fastigheterV2WriteTransport(token), pendingStore: store }) : null;
    if (fastigheterV2Writer) await fastigheterV2Writer.load();
    fastigheterV2Controller.setWriter(fastigheterV2Writer);
    setStatus(`Fastigheter V2 · revision ${result.propertyRevision} · ${fastigheterV2Writer ? 'skrivmaster' : result.writable ? 'anslut Dropbox för att skriva' : 'förhandsläge'}`, 'ok');
    return result;
  })().catch(error => {
    console.error(error);
    if (isOfflineError(error) && fastigheterV2Runtime?.hasData()) {
      fastigheterV2Controller?.render();
      setStatus('Offline · senast verifierade Fastigheter V2 visas', 'warning');
      return null;
    }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function localFastigheterV2Available() {
  if (!isSourceTree) return false;
  try { return (await fetch('/fastigheter-generation2/active.json', { method: 'HEAD', cache: 'no-store' })).ok; }
  catch { return false; }
}

async function activeFastigheterCutover(token) {
  const missing = { getJson: async () => { const error = new Error('saknas'); error.status = 409; error.code = 'path/not_found'; throw error; } };
  const transport = token ? new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-cutover-detect', opsRoot: '/fastigheter/ops', readOnly: true }) : missing;
  const guard = new GenerationCutoverGuard({ app: 'fastigheter', transport, store });
  return token ? guard.refresh({ force: true }) : guard.cachedMarker();
}

async function initFastigheterV2Mode() {
  fastigheterV2Mode = true;
  bootstrapButton.hidden = true;
  document.documentElement.dataset.fastigheterV2 = 'true';
  document.querySelector('.site-header h1').textContent = 'Fastigheter';
  document.querySelector('.site-header .intro').textContent = 'Nuvarande ägare och strukturerad tidslinje per fastighet.';
  fastigheterV2Runtime = await createFastigheterActiveRuntime({ store }).init();
  fastigheterV2Controller = createFastigheterV2Controller({
    runtime: fastigheterV2Runtime,
    content,
    drawer,
    drawerContent,
    backdrop,
    statusNode,
    onSaved: async () => {
      const token = await currentAccessToken();
      if (!token) throw new Error('Revisionen sparades, men återläsning väntar tills Dropbox är ansluten.');
      await fastigheterV2Runtime.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-generation2-after-save', opsRoot: '/fastigheter-generation2/ops', readOnly: true }));
      await fastigheterV2Writer.load();
    },
  });
  if (fastigheterV2Runtime.hasData()) fastigheterV2Controller.render();
  await syncFastigheterV2();
  const requested = new URL(location.href).searchParams.get('property');
  if (requested) fastigheterV2Controller.open(requested, { updateUrl: false });
}

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB({
    name: 'korpholmen-fastigheter',
    onBlocked: () => setStatus('En annan Fastigheter-flik blockerar uppdateringen · stäng den och ladda om', 'warning'),
  });
  store = new IndexedDBStore(db);
  await completeOAuthCallbackIfNeeded();
  const parameters = new URL(location.href).searchParams;
  const token = await currentAccessToken();
  const cutover = await activeFastigheterCutover(token);
  if (cutover?.state === 'active' || await localFastigheterV2Available() || (isSourceTree && parameters.get('propertymaster') === 'next')) {
    await initFastigheterV2Mode();
    await serviceWorkerPromise;
    return;
  }
  repository = await new Repository({ store, deviceId: await deviceId() }).init();
  matrikelMaster = await new PeopleMembershipMaster({ store }).init();
  kartdataMaster = await new ReadOnlyMaster({ store, cacheKey: 'kartdata' }).init();
  bootstrapButton.hidden = !isSourceTree;
  render();
  await syncNow();
  const requestedProperty = new URL(location.href).searchParams.get('property');
  if (requestedProperty && propertyRecords().some(property => property.id === requestedProperty)) openDrawer(requestedProperty, { updateUrl: false });
  await serviceWorkerPromise;
}

if (isMasterComparison) {
  initPropertyMasterComparison({
    content,
    drawer,
    drawerContent,
    backdrop,
    statusNode,
    toolbar: $('.toolbar'),
    connectButton,
    bootstrapButton,
  }).catch(error => { console.error(error); setStatus(`Kunde inte starta jämförelsen · ${error.message}`, 'error'); });
} else {
  content.addEventListener('click', event => {
    if (fastigheterV2Mode) {
      const target = event.target.closest('[data-v2-property]');
      if (target) fastigheterV2Controller.open(target.dataset.v2Property);
      return;
    }
    const target = event.target.closest('[data-property-id]');
    if (target) openDrawer(target.dataset.propertyId, { focusTarget: target });
  });
  backdrop.addEventListener('click', closeDrawer);
  drawer.addEventListener('click', event => {
    if (event.target.closest('[data-action="close"]')) closeDrawer();
    if (!fastigheterV2Mode) return;
    const edit = event.target.closest('[data-v2-edit-entry]');
    if (edit) fastigheterV2Controller.openEditor(fastigheterV2Runtime.properties.get('timeline_entries', edit.dataset.v2EditEntry));
    if (event.target.closest('[data-v2-new-entry]')) fastigheterV2Controller.openEditor();
  });
  const renderSearch = debounce(render, 120);
  const renderYearRange = debounce(render, 100);
  $('#search').addEventListener('input', event => { ui.search = event.target.value; renderSearch(); });
  $('#island-filter').addEventListener('change', event => { ui.island = event.target.value; render(); });
  $('#audit-filter').addEventListener('change', event => { ui.audit = event.target.value; render(); });
  $('#year-from').addEventListener('input', event => { ui.yearFrom = event.target.value; renderYearRange(); });
  $('#year-to').addEventListener('input', event => { ui.yearTo = event.target.value; renderYearRange(); });
  connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
  bootstrapButton.addEventListener('click', () => bootstrapLocal().catch(error => setStatus(error.message, 'error')));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && selectedPropertyId) closeDrawer(); });
  window.addEventListener('online', () => syncNow().catch(() => {}));
  window.addEventListener('korpholmen:dropbox-ready', () => syncNow().catch(() => {}));
  window.addEventListener('offline', () => syncNow().catch(() => {}));
  init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
}
