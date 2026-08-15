import {
  IndexedDBStore,
  KORPHOLMEN_APPS,
  Repository,
  SharedDropboxSession,
  exchangeDropboxRefreshToken,
  openSlaktlandskapDB,
  syncAppFamily,
} from '../../../packages/core/data-layer.js';
import { DROPBOX_CLIENT_ID } from '../../../src/config.js';
import { buildPersonProfile, buildSearchIndex, searchExplorer } from './projection.js';

const ENTITY_TYPES = Object.freeze({
  matrikel: ['person', 'relation', 'property-link', 'family-unit', 'kin-group'],
  batregister: ['boat', 'boat-ownership-observation', 'boat-person-link'],
  fastigheter: ['property', 'party', 'current-owner-assessment', 'community-link'],
  dokumentarkiv: ['document', 'archive-entity'],
  korpholmenrunt: ['race-result', 'race-person-link', 'race-edition'],
  klubbhistorik: ['matrikel-release', 'person-occurrence'],
  kartdata: [],
});
const TYPE_LABELS = Object.freeze({ person: 'Person', boat: 'Båt', property: 'Fastighet', document: 'Handling', year: 'Tävlingsår', 'source-text': 'Källtext' });
const SOURCE_LABELS = Object.freeze({ matrikel: 'Personer & familjer', batregister: 'Båtregistret', fastigheter: 'Fastigheter', dokumentarkiv: 'Dokumentarkivet', korpholmenrunt: 'Korpholmen runt', klubbhistorik: 'Matrikeln' });
const viewNode = document.querySelector('#explorer-view');
const searchForm = document.querySelector('#explorer-search-form');
const searchInput = document.querySelector('#explorer-search');
const reloadButton = document.querySelector('#reload-data');
const statusNode = document.querySelector('#explorer-status');
const session = new SharedDropboxSession({ clientId: DROPBOX_CLIENT_ID, exchangeRefreshToken: exchangeDropboxRefreshToken });
let masters = {};
let searchIndex = [];
let loading = false;

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const encode = value => encodeURIComponent(String(value || ''));
const unique = values => [...new Set(values.filter(Boolean))];

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `is-${tone}` : '';
}

function flattenEntity(entity) {
  const fields = entity.fields || {};
  const record = fields.record && typeof fields.record === 'object' && !Array.isArray(fields.record) ? fields.record : {};
  return { id: entity.entity_id, ...fields, ...record };
}

async function readApp(app) {
  const database = await openSlaktlandskapDB({ name: app.database });
  try {
    const store = new IndexedDBStore(database);
    const repository = await new Repository({ store, deviceId: `explorer-read-${app.id}` }).init();
    return Object.fromEntries((ENTITY_TYPES[app.id] || []).map(type => [type, repository.listEntities(type).map(flattenEntity)]));
  } finally {
    database.close();
  }
}

async function readLocalMasters() {
  const entries = await Promise.all(KORPHOLMEN_APPS.map(async app => [app.id, await readApp(app)]));
  return Object.fromEntries(entries);
}

function entityCount(data) {
  return Object.values(data).reduce((total, app) => total + Object.values(app).reduce((sum, list) => sum + list.length, 0), 0);
}

function itemHref(item) {
  if (item.type === 'person') return `./?person=${encode(item.id)}`;
  if (item.type === 'boat') return `../batregister/?boat=${encode(item.id)}`;
  if (item.type === 'property') return `../fastigheter/?property=${encode(item.id)}`;
  if (item.type === 'document') return `../dokumentarkiv/?document=${encode(item.id)}`;
  if (item.type === 'year') return `../korpholmenrunt/?year=${encode(item.id)}`;
  if (item.type === 'source-text') {
    const year = item.label.match(/\d{4}/)?.[0] || '';
    return year ? `../korpholmenrunt/?year=${encode(year)}` : '../korpholmenrunt/';
  }
  return '#';
}

function searchResultHtml(item) {
  return `<a class="search-result ${item.sourceTextOnly ? 'source-result' : ''}" href="${escapeAttribute(itemHref(item))}"><span class="result-type">${escapeHtml(TYPE_LABELS[item.type] || item.type)}</span><span class="result-copy"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail || SOURCE_LABELS[item.sourceApp] || '')}</span></span><span class="result-arrow" aria-hidden="true">→</span></a>`;
}

function renderStart() {
  viewNode.innerHTML = `<div class="start-grid"><section class="start-card"><p class="eyebrow">Börja här</p><h2>Sök efter en person</h2><p>Personsidan samlar kända relationer, båtar, fastighetsanknytningar, tävlingsresultat, dokument och matrikelutgåvor.</p><p>För båtar, fastigheter, handlingar och tävlingsår leder sökningen direkt till appen som äger uppgiften.</p></section><aside class="start-card"><p class="eyebrow">Datagräns</p><h2>En läsvy</h2><ul class="source-legend"><li><span class="source-dot"></span>Inga uppgifter sparas i Explorer</li><li><span class="source-dot"></span>Inga identiteter skapas automatiskt</li><li><span class="source-dot"></span>Okopplad källtext visas separat</li></ul></aside></div>`;
  viewNode.setAttribute('aria-busy', 'false');
}

function renderSearch(value) {
  const results = searchExplorer(searchIndex, value);
  const sourceCount = results.filter(item => item.sourceTextOnly).length;
  viewNode.innerHTML = results.length
    ? `<header class="search-heading"><h2>${results.length} träffar</h2><p>${sourceCount ? `${sourceCount} ligger enbart i källtext och är inte registerkopplade` : 'Registerkopplade träffar'}</p></header><div class="search-results">${results.map(searchResultHtml).join('')}</div>`
    : `<section class="empty-state"><h2>Ingen träff</h2><p>Prova ett namn, en båt, en fastighet, en handling eller ett år.</p></section>`;
  viewNode.setAttribute('aria-busy', 'false');
}

function yearSpan(person) {
  const born = person.birth_year || person.fodd_ar || String(person.birth_date || '').slice(0, 4);
  const died = person.death_year || person.dod_ar || String(person.death_date || '').slice(0, 4);
  if (!born && !died) return '';
  return `${born || '?'}–${died || ''}`;
}

function rowHtml({ title, meta = '', tags = [], href = '', hrefLabel = 'Öppna' }) {
  return `<li class="card-row"><span class="card-row-main"><strong>${escapeHtml(title)}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}${tags.length ? `<span class="tag-row">${tags.map(tag => `<span class="tag ${tag.caution ? 'caution' : ''}">${escapeHtml(tag.label)}</span>`).join('')}</span>` : ''}</span>${href ? `<a href="${escapeAttribute(href)}">${escapeHtml(hrefLabel)} →</a>` : ''}</li>`;
}

function cardHtml({ title, source, sourceHref, items, empty, wide = false, note = '' }) {
  return `<section class="profile-card ${wide ? 'wide' : ''}"><header class="card-head"><h3>${escapeHtml(title)}</h3>${sourceHref ? `<a href="${escapeAttribute(sourceHref)}">${escapeHtml(source)} →</a>` : ''}</header>${items.length ? `<ul class="card-list">${items.join('')}</ul>` : `<p class="card-empty">${escapeHtml(empty)}</p>`}${note ? `<p class="profile-note">${escapeHtml(note)}</p>` : ''}</section>`;
}

function renderPerson(personId) {
  const profile = buildPersonProfile(masters, personId);
  if (!profile) {
    viewNode.innerHTML = `<section class="empty-state"><h2>Personen finns inte lokalt</h2><p>Synka registren eller sök efter en annan person.</p></section>`;
    viewNode.setAttribute('aria-busy', 'false');
    return;
  }
  const p = profile.person;
  const identity = unique([yearSpan(p), p.club_name || p.klubbnamn, p.family || p.ui_clan]).join(' · ');
  const relationItems = profile.relations.map(relation => rowHtml({
    title: relation.personName,
    meta: relation.label,
    tags: relation.confirmed ? [] : [{ label: 'Ej bekräftad uppgift', caution: true }],
    href: `./?person=${encode(relation.personId)}`,
    hrefLabel: 'Visa person',
  }));
  const groupItems = profile.groups.map(group => rowHtml({
    title: unique([group.referenceCode, group.name]).join(' · '),
    meta: group.role,
    tags: group.confirmed ? [] : [{ label: 'Härledd via öppet underlag', caution: true }],
    href: `../personer-familjer/?group=${encode(group.id)}`,
    hrefLabel: 'Öppna grupp',
  }));
  const boatItems = profile.boats.map(boat => rowHtml({
    title: boat.name,
    meta: unique([boat.type, ...boat.roles, ...boat.periods]).join(' · '),
    href: `../batregister/?boat=${encode(boat.id)}`,
    hrefLabel: 'Öppna båt',
  }));
  const propertyItems = profile.properties.map(property => rowHtml({
    title: property.name,
    tags: [property.currentOwner ? { label: 'Nuvarande ägare' } : null, property.associated ? { label: 'Anknytning, inte ägaruppgift', caution: !property.currentOwner } : null].filter(Boolean),
    href: `../fastigheter/?property=${encode(property.id)}`,
    hrefLabel: 'Öppna fastighet',
  }));
  const raceItems = profile.raceResults.map(result => rowHtml({
    title: unique([result.year, result.boatName]).join(' · '),
    meta: unique([result.className, result.course, result.time]).join(' · '),
    href: `../korpholmenrunt/?year=${encode(result.year)}`,
    hrefLabel: 'Öppna året',
  }));
  const documentItems = profile.documents.map(document => rowHtml({
    title: document.title,
    meta: unique([document.date, document.type]).join(' · '),
    href: `../dokumentarkiv/?document=${encode(document.id)}`,
    hrefLabel: 'Öppna handling',
  }));
  const clubItems = profile.clubOccurrences.map(item => rowHtml({
    title: item.year ? `Matrikel ${item.year}` : item.releaseId,
    meta: unique([item.name, item.clubName, item.membershipStatus]).join(' · '),
    href: `../matrikel/?release=${encode(item.releaseId)}`,
    hrefLabel: 'Öppna utgåva',
  }));

  viewNode.innerHTML = `<header class="profile-head"><div><p class="eyebrow">Person · läsvy</p><h2>${escapeHtml(profile.name)}</h2>${identity ? `<p>${escapeHtml(identity)}</p>` : ''}</div><a class="owner-link" href="../personer-familjer/?person=${encode(profile.id)}">Öppna och ändra i Personer & familjer →</a></header><div class="profile-grid">${cardHtml({ title: 'Familj & släkt', source: 'Personer & familjer', sourceHref: `../personer-familjer/?person=${encode(profile.id)}`, items: [...relationItems, ...groupItems], empty: 'Inga kopplade relationer eller grupper.', note: 'Explorer återger personmastern. Härledda gruppmedlemskap skapar inga nya personfakta.' })}${cardHtml({ title: 'Båtar', source: 'Båtregistret', sourceHref: `../batregister/?person=${encode(profile.id)}`, items: boatItems, empty: 'Ingen kopplad båt.' })}${cardHtml({ title: 'Fastigheter', source: 'Fastigheter', sourceHref: '../fastigheter/', items: propertyItems, empty: 'Ingen kopplad fastighet.', note: 'Fastighetsanknytning visas separat från bedömt nuvarande ägande.' })}${cardHtml({ title: 'Korpholmen runt', source: 'Korpholmen runt', sourceHref: `../korpholmenrunt/?person=${encode(profile.id)}`, items: raceItems, empty: 'Inga manuellt kopplade tävlingsresultat.' })}${cardHtml({ title: 'Handlingar', source: 'Dokumentarkivet', sourceHref: '../dokumentarkiv/', items: documentItems, empty: 'Inga kopplade handlingar.' })}${cardHtml({ title: 'Matrikeln över tid', source: 'Matrikeln', sourceHref: `../matrikel/?person=${encode(profile.id)}`, items: clubItems, empty: 'Inga bekräftade förekomster i historiska matriklar.' })}</div>`;
  viewNode.setAttribute('aria-busy', 'false');
}

function renderRoute() {
  const params = new URL(location.href).searchParams;
  const personId = params.get('person');
  if (personId) renderPerson(personId);
  else if (searchInput.value.trim()) renderSearch(searchInput.value.trim());
  else renderStart();
}

async function load({ sync = false } = {}) {
  if (loading) return;
  loading = true;
  reloadButton.disabled = true;
  viewNode.setAttribute('aria-busy', 'true');
  try {
    if (sync) {
      const token = await session.getAccessToken({ online: navigator.onLine !== false });
      if (token) {
        setStatus('Hämtar senaste data från de sju registren…');
        await syncAppFamily({ accessToken: token, force: true });
      } else {
        setStatus('Dropbox är inte ansluten · läser lokala register');
      }
    }
    masters = await readLocalMasters();
    searchIndex = buildSearchIndex(masters);
    renderRoute();
    setStatus(`${entityCount(masters).toLocaleString('sv-SE')} lokala poster lästa · Explorer är skrivskyddad`, 'ok');
  } catch (error) {
    console.error(error);
    setStatus(`Kunde inte läsa registren · ${error.message}`, 'error');
    viewNode.innerHTML = `<section class="empty-state"><h2>Explorer kunde inte starta</h2><p>${escapeHtml(error.message)}</p></section>`;
    viewNode.setAttribute('aria-busy', 'false');
  } finally {
    loading = false;
    reloadButton.disabled = false;
  }
}

searchForm.addEventListener('submit', event => {
  event.preventDefault();
  const url = new URL(location.href);
  url.searchParams.delete('person');
  history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  renderSearch(searchInput.value.trim());
});
searchInput.addEventListener('input', () => {
  if (new URL(location.href).searchParams.has('person')) return;
  if (searchInput.value.trim().length >= 2) renderSearch(searchInput.value.trim());
  else if (!searchInput.value.trim()) renderStart();
});
reloadButton.addEventListener('click', () => load({ sync: true }));
window.addEventListener('popstate', renderRoute);
window.addEventListener('korpholmen:dropbox-ready', () => setStatus('Dropbox är ansluten · tryck Läs om för senaste data'));

load();
