const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

const timeLabel = time => time?.original_text || time?.start_min || time?.start_max || time?.end_min || time?.end_max || '';
const levelLabel = value => value === 'senior' ? 'Senior' : value === 'junior' ? 'Junior' : 'Ej angivet';
const lifeLabel = person => person.living === true ? 'Levande' : person.living === false ? 'Avliden' : 'Okänd livsstatus';

export class PeopleV2Controller {
  constructor({ runtime, content, drawer, drawerContent, statusNode } = {}) {
    this.runtime = runtime;
    this.content = content;
    this.drawer = drawer;
    this.drawerContent = drawerContent;
    this.statusNode = statusNode;
    this.search = '';
    this.life = '';
    this.level = '';
  }

  configureShell() {
    document.documentElement.dataset.peopleV2 = 'true';
    document.querySelector('.site-header h1').textContent = 'Personer';
    document.querySelector('.site-header .intro').textContent = 'Personmaster med medlemskap och faktiska relationer. Familjeenheter används i bakgrunden där en stabil grupplänk behövs.';
    document.querySelector('.family-model')?.setAttribute('hidden', '');
    document.querySelector('main .legend')?.setAttribute('hidden', '');
    const toolbar = document.querySelector('.toolbar');
    toolbar.innerHTML = `<div class="v2-people-toolbar"><label>Sök person eller klubbnamn<input id="v2-people-search" type="search" placeholder="Namn, klubbnamn eller kontext …"></label><label>Livsstatus<select id="v2-people-life"><option value="">Alla</option><option value="living">Levande</option><option value="dead">Avlidna</option><option value="unknown">Okänd</option></select></label><label>Medlemsnivå<select id="v2-people-level"><option value="">Alla</option><option value="senior">Seniorer</option><option value="junior">Juniorer</option><option value="none">Ej angivet</option></select></label><output id="v2-people-count"></output></div>`;
    toolbar.querySelector('#v2-people-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-life').addEventListener('change', event => { this.life = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-level').addEventListener('change', event => { this.level = event.target.value; this.render(); });
    this.content.addEventListener('click', event => {
      const button = event.target.closest('[data-v2-person]');
      if (button) this.open(button.dataset.v2Person);
    });
    this.drawer.addEventListener('click', event => {
      if (event.target.closest('[data-v2-close-person]')) this.close();
      const button = event.target.closest('[data-v2-related-person]');
      if (button) this.open(button.dataset.v2RelatedPerson);
    });
  }

  visiblePeople() {
    const needle = normalize(this.search);
    return this.runtime.listPeople().filter(person => {
      if (this.life === 'living' && person.living !== true) return false;
      if (this.life === 'dead' && person.living !== false) return false;
      if (this.life === 'unknown' && person.living !== null && person.living !== undefined) return false;
      if (this.level === 'none' && person.membership_level) return false;
      if (this.level && this.level !== 'none' && person.membership_level !== this.level) return false;
      return !needle || normalize([person.display_name, person.club_name, ...(person.aliases || []), person.context_note].join(' ')).includes(needle);
    });
  }

  render() {
    const all = this.runtime.listPeople();
    const people = this.visiblePeople();
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${people.length} av ${all.length} personer`;
    if (!all.length) {
      this.content.innerHTML = '<section class="empty"><h2>Ingen verifierad Personmaster på enheten ännu</h2><p>Anslut Dropbox för att läsa den aktiva V2-mastern.</p></section>';
      return;
    }
    this.content.innerHTML = `<section class="v2-people-register"><header><div><p class="eyebrow dark">Aktiv personmaster</p><h2>Personer</h2></div><p>Relationer öppnas på respektive person.</p></header><div class="v2-people-list">${people.map(person => `<button type="button" class="v2-person-row" data-v2-person="${escapeHtml(person.id)}"><span><b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}</span><span>${escapeHtml(levelLabel(person.membership_level))}</span><span>${escapeHtml(lifeLabel(person))}</span>${person.needs_review ? '<strong>Se över</strong>' : '<span></span>'}</button>`).join('')}</div>${people.length ? '' : '<p>Inga personer matchar filtren.</p>'}</section>`;
  }

  open(personId, { updateUrl = true } = {}) {
    const person = this.runtime.getPerson(personId);
    if (!person) return;
    const relations = this.runtime.relationsFor(personId).map(relation => ({ relation, person: this.runtime.relatedPerson(relation, personId) })).filter(row => row.person);
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">Personmaster</p><h2>${escapeHtml(person.display_name)}</h2>${person.club_name ? `<p><i>${escapeHtml(person.club_name)}</i></p>` : ''}</div><button type="button" data-v2-close-person aria-label="Stäng">×</button></header><dl class="v2-person-facts"><div><dt>Livsstatus</dt><dd>${escapeHtml(lifeLabel(person))}</dd></div><div><dt>Född</dt><dd>${escapeHtml(timeLabel(person.birth_time) || 'Ej angivet')}</dd></div><div><dt>Död</dt><dd>${escapeHtml(timeLabel(person.death_time) || '—')}</dd></div><div><dt>Medlemsnivå</dt><dd>${escapeHtml(levelLabel(person.membership_level))}</dd></div>${person.membership_form ? `<div><dt>Medlemsform</dt><dd>${escapeHtml(person.membership_form)}</dd></div>` : ''}${person.induction_year ? `<div><dt>Invalsår</dt><dd>${escapeHtml(person.induction_year)}</dd></div>` : ''}</dl>${person.aliases?.length ? `<section class="drawer-section"><h3>Andra namnformer</h3><p>${person.aliases.map(escapeHtml).join(', ')}</p></section>` : ''}${person.context_note ? `<section class="drawer-section"><h3>Kontext</h3><p>${escapeHtml(person.context_note)}</p></section>` : ''}${person.needs_review && person.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(person.review_comment)}</p></section>` : ''}<section class="drawer-section"><h3>Relationer</h3><div class="v2-person-relations">${relations.map(({ relation, person: related }) => `<button type="button" data-v2-related-person="${escapeHtml(related.id)}"><span>${escapeHtml(this.runtime.relationLabel(relation, personId))}</span><b>${escapeHtml(related.display_name)}</b>${relation.needs_review ? '<i>Se över</i>' : ''}</button>`).join('') || '<p>Inga strukturerade relationer.</p>'}</div></section>`;
    this.drawer.setAttribute('aria-hidden', 'false');
    this.drawer.classList.add('open');
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('person', person.id);
      history.replaceState(null, '', url);
    }
  }

  close() {
    this.drawer.setAttribute('aria-hidden', 'true');
    this.drawer.classList.remove('open');
    this.drawerContent.innerHTML = '';
    const url = new URL(location.href);
    url.searchParams.delete('person');
    history.replaceState(null, '', url);
  }
}

export const createPeopleV2Controller = options => new PeopleV2Controller(options);
