import { createActiveAppBundle } from '../core/active-app-bundle.js';
import { buildRecordViewModel, recordTimeLabel } from './record-ranking.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'sv', { numeric: true });
const VIEWS = new Set(['oversikt', 'resultat', 'arsvis', 'rekord', 'profiler', 'duell', 'matchning']);

const metric = (value, label) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;

export class RaceActiveV2 {
  constructor({ store, view } = {}) {
    this.bundle = createActiveAppBundle({ store, cacheKey: 'race-active-v2', sources: {
      race: { pointerPath: '/korpholmenrunt-generation2/active.json', app: 'korpholmenrunt', requiredCollections: ['editions', 'results', 'participants', 'classes', 'courses', 'sources'] },
      people: { pointerPath: '/personer-familjer/active.json', app: 'people', requiredCollections: ['people'] },
      boats: { pointerPath: '/batregister-generation2/active.json', app: 'batregister', requiredCollections: ['boats', 'identity_redirects'] },
    } });
    this.view = view;
    this.search = '';
    this.year = '';
    this.classId = '';
    this.mode = 'oversikt';
    this.duelLeft = '';
    this.duelRight = '';
    this.expandedRecordGroups = new Set();
  }

  async init() {
    await this.bundle.init();
    const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
    if (params.has('year')) { this.year = params.get('year'); this.mode = 'arsvis'; }
    if (params.has('person') || params.has('boat')) this.mode = 'profiler';
    return this;
  }

  hasData() { return this.bundle.hasData('race'); }
  async sync(transport) { return this.bundle.sync(transport); }
  list(source, collection) { return this.bundle.list(source, collection); }
  participantsFor(result) { return this.list('race', 'participants').filter(row => row.result_id === result.id).sort((a, b) => a.participant_order - b.participant_order); }
  personName(participant) { return participant.person_ref ? this.bundle.get('people', 'people', participant.person_ref.entity_id)?.display_name || participant.raw_name : participant.raw_name; }
  boatName(result) { return result.boat_ref ? this.bundle.get('boats', 'boats', result.boat_ref.entity_id)?.display_name || result.boat_name_raw : result.boat_name_raw; }

  configureShell() {
    document.documentElement.dataset.raceV2 = 'true';
    const navigation = document.querySelector('.huvudnav');
    if (navigation) navigation.hidden = false;
    const tools = document.querySelector('.verktygsrad');
    tools.innerHTML = `<label class="sok"><span>⌕</span><input id="v2-race-search" type="search" placeholder="Person, båt, år eller klass …"></label><div class="snabbfilter"><select id="v2-race-year"><option value="">Alla år</option></select><select id="v2-race-class"><option value="">Alla klasser</option></select></div><output id="v2-race-count"></output>`;
    tools.querySelector('#v2-race-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    tools.querySelector('#v2-race-year').addEventListener('change', event => { this.year = event.target.value; this.render(); });
    tools.querySelector('#v2-race-class').addEventListener('change', event => { this.classId = event.target.value; this.render(); });
    this.view.addEventListener('click', event => {
      const year = event.target.closest('[data-v2-race-year]')?.dataset.v2RaceYear;
      if (year) {
        this.year = year;
        const select = document.querySelector('#v2-race-year');
        if (select) select.value = year;
        this.setView('arsvis');
      }
      const profile = event.target.closest('[data-v2-race-profile]')?.dataset.v2RaceProfile;
      if (profile) this.renderProfile(profile);
      const recordToggle = event.target.closest('[data-v2-record-toggle]')?.dataset.v2RecordToggle;
      if (recordToggle) {
        if (this.expandedRecordGroups.has(recordToggle)) this.expandedRecordGroups.delete(recordToggle);
        else this.expandedRecordGroups.add(recordToggle);
        this.render();
      }
    });
    this.view.addEventListener('change', event => {
      if (event.target.matches('[data-v2-duel-left]')) { this.duelLeft = event.target.value; this.render(); }
      if (event.target.matches('[data-v2-duel-right]')) { this.duelRight = event.target.value; this.render(); }
    });
  }

  setView(mode) {
    this.mode = VIEWS.has(mode) ? mode : 'oversikt';
    this.render();
  }

  populateFilters() {
    const year = document.querySelector('#v2-race-year');
    const klass = document.querySelector('#v2-race-class');
    if (year?.options.length === 1) year.insertAdjacentHTML('beforeend', [...new Set(this.list('race', 'results').map(row => row.year))].sort((a, b) => b - a).map(value => `<option>${value}</option>`).join(''));
    if (klass?.options.length === 1) klass.insertAdjacentHTML('beforeend', this.list('race', 'classes').sort((a, b) => compare(a.name, b.name)).map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join(''));
    if (year) year.value = this.year;
    if (klass) klass.value = this.classId;
  }

  visible() {
    const needle = normalize(this.search);
    return this.list('race', 'results').filter(result => {
      if (this.year && String(result.year) !== this.year) return false;
      if (this.classId && result.class_id !== this.classId) return false;
      const participants = this.participantsFor(result);
      return !needle || normalize([result.year, result.class_name, result.class_raw, result.course_code, result.time_raw, this.boatName(result), ...participants.map(row => this.personName(row))].join(' ')).includes(needle);
    }).sort((a, b) => b.year - a.year || compare(a.class_name, b.class_name) || (a.duration_seconds || Infinity) - (b.duration_seconds || Infinity));
  }

  updateChrome(rows) {
    document.querySelectorAll('.huvudnav [data-view]').forEach(button => {
      const active = button.dataset.view === this.mode;
      button.classList.toggle('aktiv', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    const unresolved = this.unresolved().length;
    const reviewCount = document.querySelector('#review-count');
    if (reviewCount) reviewCount.textContent = String(unresolved);
    const count = document.querySelector('#v2-race-count');
    if (count) count.textContent = `${rows.length} av ${this.list('race', 'results').length} resultat`;
  }

  personLink(participant) {
    const name = escapeHtml(this.personName(participant) || 'Okänd');
    return participant.person_ref ? `<a href="../personer-familjer/?person=${encodeURIComponent(participant.person_ref.entity_id)}">${name}</a>` : `<span class="v2-unlinked">${name}</span>`;
  }

  boatLink(result) {
    const name = escapeHtml(this.boatName(result) || 'Ej angiven');
    return result.boat_ref ? `<a href="../batregister/?boat=${encodeURIComponent(result.boat_ref.entity_id)}">${name}</a>` : `<span class="v2-unlinked">${name}</span>`;
  }

  resultTable(rows) {
    if (!rows.length) return '<section class="tom"><h2>Inga resultat</h2><p>Anslut Dropbox eller ändra filtren.</p></section>';
    return `<section class="v2-race-table"><header><span>År</span><span>Tävlande</span><span>Båt</span><span>Klass</span><span>Bana</span><span>Tid</span></header>${rows.map(result => `<article><b>${result.year}</b><span>${this.participantsFor(result).map(row => this.personLink(row)).join(', ') || '—'}</span><span>${this.boatLink(result)}</span><span>${escapeHtml(result.class_name || result.class_raw || '—')}</span><span>${escapeHtml(result.course_code || '—')}</span><time>${escapeHtml(result.time_raw || '—')}</time></article>`).join('')}</section>`;
  }

  renderOverview(rows) {
    const years = [...new Set(rows.map(row => row.year))].sort((a, b) => b - a);
    const linkedPeople = new Set(this.list('race', 'participants').map(row => row.person_ref?.entity_id).filter(Boolean));
    const linkedBoats = new Set(this.list('race', 'results').map(row => row.boat_ref?.entity_id).filter(Boolean));
    const classCounts = new Map();
    rows.forEach(row => classCounts.set(row.class_name || row.class_raw || 'Okänd klass', (classCounts.get(row.class_name || row.class_raw || 'Okänd klass') || 0) + 1));
    const latest = years.slice(0, 12);
    this.view.innerHTML = `<section class="v2-race-overview"><div class="v2-race-hero"><p class="overrad">Aktiv V2-master</p><h2>Korpholmen runt genom åren</h2><p>Resultat, deltagare och båtar läses ur den nya gemensamma mastern.</p><div class="v2-race-metrics">${metric(rows.length, 'resultat')}${metric(years.length, 'tävlingsår')}${metric(linkedPeople.size, 'kopplade personer')}${metric(linkedBoats.size, 'kopplade båtar')}</div></div><div class="v2-race-panel"><h3>Senaste tävlingsåren</h3><div class="v2-year-links">${latest.map(year => `<button type="button" data-v2-race-year="${year}">${year}<small>${rows.filter(row => row.year === year).length} resultat</small></button>`).join('')}</div></div><div class="v2-race-panel"><h3>Klasser</h3><div class="v2-class-list">${[...classCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `<span><b>${escapeHtml(name)}</b><small>${count} resultat</small></span>`).join('')}</div></div></section>`;
  }

  renderYears(rows) {
    const byYear = new Map();
    rows.forEach(row => { if (!byYear.has(row.year)) byYear.set(row.year, []); byYear.get(row.year).push(row); });
    this.view.innerHTML = byYear.size ? `<section class="v2-year-sections">${[...byYear].sort((a, b) => b[0] - a[0]).map(([year, items]) => `<article><header><h2>${year}</h2><span>${items.length} resultat · ${new Set(items.map(row => row.class_id || row.class_raw)).size} klasser</span></header>${this.resultTable(items)}</article>`).join('')}</section>` : this.resultTable([]);
  }

  renderRecords(rows) {
    const model = buildRecordViewModel(rows, { expandedGroups: this.expandedRecordGroups });
    const resultRow = item => `<div class="v2-record-row"><b>${item.rank || '—'}</b><time>${escapeHtml(recordTimeLabel(item))}${item.timeStatusLabel && item.timeStatus !== 'fusk' ? `<small>${escapeHtml(item.timeStatusLabel)}</small>` : ''}</time><span>${this.participantsFor(item.result).map(person => this.personLink(person)).join(', ') || '—'}<small>${this.boatLink(item.result)} · ${item.result.year}</small></span></div>`;
    const sections = model.sections.map(section => `<section class="v2-record-course" data-course="${escapeHtml(section.courseCode)}"><header><p>Resultat per klass</p><h2>${escapeHtml(section.courseName)}</h2></header><div class="v2-record-grid">${section.groups.map(group => `<article class="v2-record-card"><header><div><h3>${escapeHtml(group.className)}</h3><span>${group.total} resultat</span></div></header>${group.items.map(resultRow).join('')}${group.total > model.limit ? `<button class="v2-record-toggle" type="button" data-v2-record-toggle="${escapeHtml(group.key)}" aria-expanded="${group.expanded}">${group.expanded ? 'Visa topp 10' : `Visa alla ${group.total}`}</button>` : ''}</article>`).join('')}</div></section>`).join('');
    const ungrouped = model.ungrouped.length ? `<details class="v2-record-review"><summary><b>${model.ungrouped.length} resultat saknar fullständig bana eller klass</b><span>De är inte bortfiltrerade utan visas här eftersom de inte kan placeras i en bestämd topplista.</span></summary><div class="v2-record-review-list">${model.ungrouped.map(item => `<article><strong>${escapeHtml(item.reasonLabel)}</strong><span>${item.result.year} · ${escapeHtml(item.result.class_name || item.result.class_raw || 'Okänd klass')} · ${this.participantsFor(item.result).map(person => this.personLink(person)).join(', ') || '—'}</span><span>${this.boatLink(item.result)}</span><time>${escapeHtml(recordTimeLabel(item))}${item.timeStatusLabel && item.timeStatus !== 'fusk' ? ` · ${escapeHtml(item.timeStatusLabel)}` : ''}</time></article>`).join('')}</div></details>` : '';
    const summary = `<header class="v2-record-summary"><div><p class="overrad">Topptider</p><h2>Alla resultat visas inom sin bana och klass</h2></div><p><b>${model.total}</b> resultat totalt. ${model.rankable} har en numerisk tid och rangordnas; ${model.withoutNumericTime} saknar exakt numerisk tid men visas ändå. Varje klass visar först tio rader; välj <i>Visa alla</i> för hela klassen.${model.derivedTimes ? ` ${model.derivedTimes} tydliga tider läses tillfälligt direkt från tidsfältet och är förberedda för nästa masterrevision.` : ''}</p></header>`;
    this.view.innerHTML = sections ? `<section class="v2-records">${summary}${sections}${ungrouped}</section>` : `<section class="v2-records">${summary}<section class="tom"><h2>Inga klassindelade resultat</h2><p>Valda filter saknar resultat med både bana och strukturerad klass.</p></section>${ungrouped}</section>`;
  }

  profileEntries(rows) {
    const profiles = new Map();
    rows.forEach(result => {
      this.participantsFor(result).forEach(participant => {
        const key = participant.person_ref ? `person:${participant.person_ref.entity_id}` : `raw-person:${normalize(participant.raw_name)}`;
        const current = profiles.get(key) || { key, kind: 'person', name: this.personName(participant) || 'Okänd', linked: Boolean(participant.person_ref), results: [], years: new Set() };
        current.results.push(result); current.years.add(result.year); profiles.set(key, current);
      });
      if (result.boat_name_raw || result.boat_ref) {
        const key = result.boat_ref ? `boat:${result.boat_ref.entity_id}` : `raw-boat:${normalize(result.boat_name_raw)}`;
        const current = profiles.get(key) || { key, kind: 'boat', name: this.boatName(result) || 'Okänd båt', linked: Boolean(result.boat_ref), results: [], years: new Set() };
        current.results.push(result); current.years.add(result.year); profiles.set(key, current);
      }
    });
    return [...profiles.values()].sort((a, b) => b.results.length - a.results.length || compare(a.name, b.name));
  }

  renderProfiles(rows) {
    const profiles = this.profileEntries(rows);
    this.view.innerHTML = profiles.length ? `<section class="v2-profile-grid">${profiles.map(profile => `<button type="button" data-v2-race-profile="${escapeHtml(profile.key)}"><small>${profile.kind === 'person' ? 'Person' : 'Båt'}${profile.linked ? ' · kopplad' : ' · ej kopplad'}</small><h3>${escapeHtml(profile.name)}</h3><span>${profile.results.length} resultat · ${profile.years.size} år</span></button>`).join('')}</section>` : this.resultTable([]);
  }

  renderProfile(key) {
    const profile = this.profileEntries(this.visible()).find(row => row.key === key);
    if (!profile) return;
    const [kind, id] = key.split(':');
    const masterLink = profile.linked && kind === 'person' ? `<a href="../personer-familjer/?person=${encodeURIComponent(id)}">Öppna personakten →</a>` : profile.linked && kind === 'boat' ? `<a href="../batregister/?boat=${encodeURIComponent(id)}">Öppna båtakten →</a>` : '';
    this.view.innerHTML = `<section class="v2-profile-detail"><button type="button" data-view="profiler">← Alla människor och båtar</button><header><small>${profile.kind === 'person' ? 'Person' : 'Båt'}</small><h2>${escapeHtml(profile.name)}</h2><p>${profile.results.length} resultat under ${profile.years.size} år</p>${masterLink}</header>${this.resultTable(profile.results.sort((a, b) => b.year - a.year))}</section>`;
  }

  renderDuel(rows) {
    const people = this.profileEntries(rows).filter(row => row.kind === 'person' && row.linked);
    if (!this.duelLeft) this.duelLeft = people[0]?.key || '';
    if (!this.duelRight) this.duelRight = people[1]?.key || people[0]?.key || '';
    const option = profile => `<option value="${escapeHtml(profile.key)}">${escapeHtml(profile.name)}</option>`;
    const left = people.find(row => row.key === this.duelLeft);
    const right = people.find(row => row.key === this.duelRight);
    const side = profile => profile ? `<div><h3>${escapeHtml(profile.name)}</h3>${metric(profile.results.length, 'resultat')}${metric(profile.years.size, 'tävlingsår')}${metric(Math.min(...profile.results.map(row => row.year)), 'första år')}</div>` : '<div>Välj person</div>';
    this.view.innerHTML = people.length ? `<section class="v2-duel"><div class="duellval"><label><span>Person 1</span><select data-v2-duel-left>${people.map(option).join('')}</select></label><div class="mot">mot</div><label><span>Person 2</span><select data-v2-duel-right>${people.map(option).join('')}</select></label></div><article class="duellkort">${side(left)}<div class="duellmitt">Jämförelse</div>${side(right)}</article><p class="v2-duel-note">Jämförelsen visar antal registrerade resultat och år, inte vem som är ”bäst”.</p></section>` : '<section class="tom"><h2>Inga kopplade personer</h2></section>';
    const leftSelect = this.view.querySelector('[data-v2-duel-left]'); if (leftSelect) leftSelect.value = this.duelLeft;
    const rightSelect = this.view.querySelector('[data-v2-duel-right]'); if (rightSelect) rightSelect.value = this.duelRight;
  }

  unresolved() {
    const people = this.list('race', 'participants').filter(row => !row.person_ref && !row.placeholder_id).map(row => ({ kind: 'person', name: row.raw_name || 'Okänt namn', year: this.list('race', 'results').find(result => result.id === row.result_id)?.year }));
    const boats = this.list('race', 'results').filter(row => !row.boat_ref && row.boat_name_raw).map(row => ({ kind: 'boat', name: row.boat_name_raw, year: row.year }));
    return [...people, ...boats];
  }

  renderMatching() {
    const grouped = new Map();
    this.unresolved().forEach(item => {
      const key = `${item.kind}:${normalize(item.name)}`;
      const current = grouped.get(key) || { ...item, count: 0, years: new Set() };
      current.count += 1; if (item.year) current.years.add(item.year); grouped.set(key, current);
    });
    const rows = [...grouped.values()].sort((a, b) => b.count - a.count || compare(a.name, b.name));
    this.view.innerHTML = rows.length ? `<section class="v2-match-readonly"><header><h2>Återstående kopplingar</h2><p>Detta är en läslista. Ändringar görs i granskningsverktyget och publiceras därefter till mastern.</p></header>${rows.map(row => `<article><span>${row.kind === 'person' ? 'Person' : 'Båt'}</span><b>${escapeHtml(row.name)}</b><small>${row.count} förekomster · ${[...row.years].sort((a, b) => a - b).join(', ')}</small></article>`).join('')}</section>` : '<section class="tom"><h2>Inga olösta kopplingar</h2><p>Alla registrerade namn och båtar är kopplade eller uttryckligen avslutade.</p></section>';
  }

  render() {
    this.populateFilters();
    const rows = this.visible();
    this.updateChrome(rows);
    if (this.mode === 'oversikt') this.renderOverview(rows);
    else if (this.mode === 'resultat') this.view.innerHTML = this.resultTable(rows);
    else if (this.mode === 'arsvis') this.renderYears(rows);
    else if (this.mode === 'rekord') this.renderRecords(rows);
    else if (this.mode === 'profiler') this.renderProfiles(rows);
    else if (this.mode === 'duell') this.renderDuel(rows);
    else this.renderMatching();
  }
}
