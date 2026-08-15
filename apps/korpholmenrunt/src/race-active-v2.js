import { createActiveAppBundle } from '../../../packages/core/active-app-bundle.js';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

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
  }
  async init() { await this.bundle.init(); return this; }
  hasData() { return this.bundle.hasData('race'); }
  async sync(transport) { return this.bundle.sync(transport); }
  list(source, collection) { return this.bundle.list(source, collection); }
  participantsFor(result) { return this.list('race', 'participants').filter(row => row.result_id === result.id).sort((a, b) => a.participant_order - b.participant_order); }
  personName(participant) { return participant.person_ref ? this.bundle.get('people', 'people', participant.person_ref.entity_id)?.display_name || participant.raw_name : participant.raw_name; }
  boatName(result) { return result.boat_ref ? this.bundle.get('boats', 'boats', result.boat_ref.entity_id)?.display_name || result.boat_name_raw : result.boat_name_raw; }
  configureShell() {
    document.documentElement.dataset.raceV2 = 'true';
    document.querySelector('.huvudnav')?.setAttribute('hidden', '');
    const tools = document.querySelector('.verktygsrad');
    tools.innerHTML = `<label class="sok"><span>⌕</span><input id="v2-race-search" type="search" placeholder="Person, båt, år eller klass …"></label><div class="snabbfilter"><select id="v2-race-year"><option value="">Alla år</option></select><select id="v2-race-class"><option value="">Alla klasser</option></select></div><output id="v2-race-count"></output>`;
    tools.querySelector('#v2-race-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    tools.querySelector('#v2-race-year').addEventListener('change', event => { this.year = event.target.value; this.render(); });
    tools.querySelector('#v2-race-class').addEventListener('change', event => { this.classId = event.target.value; this.render(); });
  }
  populateFilters() {
    const year = document.querySelector('#v2-race-year');
    const klass = document.querySelector('#v2-race-class');
    if (year?.options.length === 1) year.insertAdjacentHTML('beforeend', [...new Set(this.list('race', 'results').map(row => row.year))].sort((a, b) => b - a).map(value => `<option>${value}</option>`).join(''));
    if (klass?.options.length === 1) klass.insertAdjacentHTML('beforeend', this.list('race', 'classes').sort((a, b) => a.name.localeCompare(b.name, 'sv')).map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join(''));
  }
  visible() {
    const needle = normalize(this.search);
    return this.list('race', 'results').filter(result => {
      if (this.year && String(result.year) !== this.year) return false;
      if (this.classId && result.class_id !== this.classId) return false;
      const participants = this.participantsFor(result);
      return !needle || normalize([result.year, result.class_name, result.course_code, result.time_raw, this.boatName(result), ...participants.map(row => this.personName(row))].join(' ')).includes(needle);
    }).sort((a, b) => b.year - a.year || String(a.class_name).localeCompare(String(b.class_name), 'sv') || (a.duration_seconds || Infinity) - (b.duration_seconds || Infinity));
  }
  render() {
    this.populateFilters();
    const rows = this.visible();
    const count = document.querySelector('#v2-race-count'); if (count) count.textContent = `${rows.length} av ${this.list('race', 'results').length} resultat`;
    this.view.innerHTML = rows.length ? `<section class="v2-race-table"><header><span>År</span><span>Tävlande</span><span>Båt</span><span>Klass</span><span>Bana</span><span>Tid</span></header>${rows.map(result => { const participants = this.participantsFor(result); const names = participants.map(participant => participant.person_ref ? `<a href="../personer-familjer/?person=${encodeURIComponent(participant.person_ref.entity_id)}">${escapeHtml(this.personName(participant))}</a>` : `<span class="v2-unlinked">${escapeHtml(participant.raw_name || 'Okänd')}</span>`).join(', '); const boat = result.boat_ref ? `<a href="../batregister/?boat=${encodeURIComponent(result.boat_ref.entity_id)}">${escapeHtml(this.boatName(result))}</a>` : `<span class="v2-unlinked">${escapeHtml(result.boat_name_raw || 'Ej angiven')}</span>`; return `<article><b>${result.year}</b><span>${names || '—'}</span><span>${boat}</span><span>${escapeHtml(result.class_name || result.class_raw || '—')}</span><span>${escapeHtml(result.course_code || '—')}</span><time>${escapeHtml(result.time_raw || '—')}</time></article>`; }).join('')}</section>` : '<section class="tom"><h2>Inga resultat</h2><p>Anslut Dropbox eller ändra filtren.</p></section>';
  }
}
