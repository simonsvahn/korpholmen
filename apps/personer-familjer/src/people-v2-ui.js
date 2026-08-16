const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

const timeLabel = time => time?.original_text || time?.start_min || time?.start_max || time?.end_min || time?.end_max || '';
const levelLabel = value => value === 'senior' ? 'Senior' : value === 'junior' ? 'Junior' : 'Ej angivet';
const lifeLabel = person => person.living === true ? 'Levande' : person.living === false ? 'Avliden' : 'Okänd livsstatus';
const familyLabel = family => family.display_name || family.reference_code || 'Familj';

function personButton(person, { relation = '', compact = false } = {}) {
  return `<button type="button" class="v2-tree-person${compact ? ' compact' : ''}" data-v2-related-person="${escapeHtml(person.id)}">${relation ? `<span>${escapeHtml(relation)}</span>` : ''}<b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}<small>${escapeHtml(lifeLabel(person))}</small></button>`;
}

function familyTree(family) {
  const anchors = family.anchors || [];
  const children = family.children || [];
  return `<div class="v2-family-tree" aria-label="Familjeträd för ${escapeHtml(familyLabel(family))}"><div class="v2-tree-parents">${anchors.map(person => personButton(person)).join('<span class="v2-partner-line" aria-label="partner">—</span>') || '<p>Ankarpersoner saknas.</p>'}</div>${children.length ? `<div class="v2-tree-stem" aria-hidden="true"></div><div class="v2-tree-children">${children.map(person => personButton(person, { compact: true })).join('')}</div>` : '<p class="v2-no-children">Inga gemensamma barn ingår i familjeenheten.</p>'}</div>`;
}

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
    this.mode = 'people';
  }

  configureShell() {
    document.documentElement.dataset.peopleV2 = 'true';
    document.querySelector('.site-header h1').textContent = 'Personer & familjer';
    document.querySelector('.site-header .intro').textContent = 'Personer är grunden. Familjer och släktträd räknas från den aktiva personmasterns stabila ID:n och faktiska relationer.';
    document.querySelector('.family-model')?.setAttribute('hidden', '');
    document.querySelector('main .legend')?.setAttribute('hidden', '');
    const toolbar = document.querySelector('.toolbar');
    toolbar.innerHTML = `<div class="v2-register-tabs" role="tablist" aria-label="Personer eller familjer"><button type="button" role="tab" data-v2-mode="people" aria-selected="true">Personer</button><button type="button" role="tab" data-v2-mode="families" aria-selected="false">Familjer</button></div><div class="v2-people-toolbar"><label>Sök<input id="v2-people-search" type="search" placeholder="Namn, klubbnamn, familj eller kontext …"></label><label class="v2-person-filter">Livsstatus<select id="v2-people-life"><option value="">Alla</option><option value="living">Levande</option><option value="dead">Avlidna</option><option value="unknown">Okänd</option></select></label><label class="v2-person-filter">Medlemsnivå<select id="v2-people-level"><option value="">Alla</option><option value="senior">Seniorer</option><option value="junior">Juniorer</option><option value="none">Ej angivet</option></select></label><output id="v2-people-count"></output></div>`;
    toolbar.querySelector('#v2-people-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-life').addEventListener('change', event => { this.life = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-level').addEventListener('change', event => { this.level = event.target.value; this.render(); });
    toolbar.querySelector('.v2-register-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-v2-mode]');
      if (!button) return;
      this.mode = button.dataset.v2Mode;
      this.render();
    });
    this.content.addEventListener('click', event => {
      const person = event.target.closest('[data-v2-person]');
      const family = event.target.closest('[data-v2-family]');
      if (person) this.open(person.dataset.v2Person);
      if (family) this.openFamily(family.dataset.v2Family);
    });
    this.drawer.addEventListener('click', event => {
      if (event.target.closest('[data-v2-close-person]')) this.close();
      const person = event.target.closest('[data-v2-related-person]');
      const family = event.target.closest('[data-v2-related-family]');
      if (person) this.open(person.dataset.v2RelatedPerson);
      if (family) this.openFamily(family.dataset.v2RelatedFamily);
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

  visibleFamilies() {
    const needle = normalize(this.search);
    return this.runtime.listFamilies().filter(family => !needle || normalize([familyLabel(family), family.reference_code, ...family.anchors.map(person => person.display_name), ...family.children.map(person => person.display_name)].join(' ')).includes(needle));
  }

  render() {
    const all = this.runtime.listPeople();
    const tabs = document.querySelectorAll('[data-v2-mode]');
    tabs.forEach(button => button.setAttribute('aria-selected', String(button.dataset.v2Mode === this.mode)));
    document.querySelectorAll('.v2-person-filter').forEach(node => { node.hidden = this.mode !== 'people'; });
    if (!all.length) {
      this.content.innerHTML = '<section class="empty"><h2>Ingen verifierad Personmaster på enheten ännu</h2><p>Anslut Dropbox för att läsa den aktiva V2-mastern.</p></section>';
      return;
    }
    if (this.mode === 'families') this.renderFamilies();
    else this.renderPeople();
  }

  renderPeople() {
    const all = this.runtime.listPeople();
    const people = this.visiblePeople();
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${people.length} av ${all.length} personer`;
    this.content.innerHTML = `<section class="v2-people-register"><header><div><p class="eyebrow dark">Aktiv personmaster</p><h2>Personer</h2></div><p>Öppna en person för relationer och familjeträd.</p></header><div class="v2-people-list">${people.map(person => `<button type="button" class="v2-person-row" data-v2-person="${escapeHtml(person.id)}"><span><b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}</span><span>${escapeHtml(levelLabel(person.membership_level))}</span><span>${escapeHtml(lifeLabel(person))}</span>${person.needs_review ? '<strong>Se över</strong>' : '<span></span>'}</button>`).join('')}</div>${people.length ? '' : '<p>Inga personer matchar filtren.</p>'}</section>`;
  }

  renderFamilies() {
    const all = this.runtime.listFamilies();
    const families = this.visibleFamilies();
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${families.length} av ${all.length} familjer`;
    this.content.innerHTML = `<section class="v2-people-register v2-family-register"><header><div><p class="eyebrow dark">Stabila familjeenheter</p><h2>Familjer</h2></div><p>Familjer används som grupplänk; relationerna avgör trädet.</p></header><div class="v2-family-list">${families.map(family => `<button type="button" class="v2-family-row" data-v2-family="${escapeHtml(family.id)}"><span><small>${escapeHtml(family.reference_code || '')}</small><b>${escapeHtml(familyLabel(family))}</b></span><span>${family.anchors.map(person => escapeHtml(person.display_name)).join(' · ') || 'Ankarperson saknas'}</span><span>${family.children.length ? `${family.children.length} gemensamma barn` : 'Inga barn i enheten'}</span>${family.needs_review ? '<strong>Se över</strong>' : '<span></span>'}</button>`).join('')}</div>${families.length ? '' : '<p>Inga familjer matchar sökningen.</p>'}</section>`;
  }

  contextHtml(personId) {
    const boats = this.runtime.boatsFor(personId);
    const properties = this.runtime.propertiesFor(personId);
    const documents = this.runtime.documentsFor(personId);
    const raceYears = this.runtime.raceYearsFor(personId);
    const rows = [
      boats.length ? `<div><h4>Båtar <span>${boats.length}</span></h4>${boats.map(boat => `<a href="../batregister/?boat=${encodeURIComponent(boat.id)}">${escapeHtml(boat.display_name || boat.id)}</a>`).join('')}</div>` : '',
      properties.length ? `<div><h4>Fastigheter <span>${properties.length}</span></h4>${properties.map(property => `<a href="../fastigheter/?property=${encodeURIComponent(property.id)}">${escapeHtml(property.designation || property.display_name || property.id)}</a>`).join('')}</div>` : '',
      documents.length ? `<div><h4>Dokument <span>${documents.length}</span></h4>${documents.slice(0, 8).map(document => `<a href="../dokumentarkiv/?document=${encodeURIComponent(document.id)}">${escapeHtml(document.title || document.id)}</a>`).join('')}${documents.length > 8 ? `<p>${documents.length - 8} ytterligare dokument finns i Dokumentarkivet.</p>` : ''}</div>` : '',
      raceYears.length ? `<div><h4>Korpholmen runt <span>${raceYears.reduce((sum, row) => sum + row.count, 0)}</span></h4>${raceYears.map(row => `<a href="../korpholmenrunt/?year=${encodeURIComponent(row.year)}">${escapeHtml(row.year)} · ${row.count} ${row.count === 1 ? 'resultat' : 'resultat'}</a>`).join('')}</div>` : '',
    ].filter(Boolean);
    return rows.length ? `<section class="drawer-section"><h3>Sammanhang i andra register</h3><div class="v2-context-links">${rows.join('')}</div></section>` : '';
  }

  open(personId, { updateUrl = true } = {}) {
    const person = this.runtime.getPerson(personId);
    if (!person) return;
    const relations = this.runtime.relationsFor(personId).map(relation => ({ relation, person: this.runtime.relatedPerson(relation, personId) })).filter(row => row.person);
    const families = this.runtime.familiesFor(personId);
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">Personmaster</p><h2>${escapeHtml(person.display_name)}</h2>${person.club_name ? `<p><i>${escapeHtml(person.club_name)}</i></p>` : ''}</div><button type="button" data-v2-close-person aria-label="Stäng">×</button></header><dl class="v2-person-facts"><div><dt>Livsstatus</dt><dd>${escapeHtml(lifeLabel(person))}</dd></div><div><dt>Född</dt><dd>${escapeHtml(timeLabel(person.birth_time) || 'Ej angivet')}</dd></div><div><dt>Död</dt><dd>${escapeHtml(timeLabel(person.death_time) || '—')}</dd></div><div><dt>Medlemsnivå</dt><dd>${escapeHtml(levelLabel(person.membership_level))}</dd></div>${person.membership_form ? `<div><dt>Medlemsform</dt><dd>${escapeHtml(person.membership_form)}</dd></div>` : ''}${person.induction_year ? `<div><dt>Invalsår</dt><dd>${escapeHtml(person.induction_year)}</dd></div>` : ''}</dl><div class="v2-master-links"><a href="../matrikel/?person=${encodeURIComponent(person.id)}">Visa i Matrikel →</a></div>${person.aliases?.length ? `<section class="drawer-section"><h3>Andra namnformer</h3><p>${person.aliases.map(escapeHtml).join(', ')}</p></section>` : ''}${person.context_note ? `<section class="drawer-section"><h3>Kontext</h3><p>${escapeHtml(person.context_note)}</p></section>` : ''}${person.needs_review && person.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(person.review_comment)}</p></section>` : ''}<section class="drawer-section"><h3>Familjeträd</h3>${families.map(family => `<article class="v2-drawer-family"><button type="button" class="v2-family-title" data-v2-related-family="${escapeHtml(family.id)}"><small>${escapeHtml(family.reference_code || '')}</small><b>${escapeHtml(familyLabel(family))}</b></button>${familyTree(family)}</article>`).join('') || '<p>Personen ingår inte i någon stabil familjeenhet ännu.</p>'}</section><section class="drawer-section"><h3>Direkta relationer</h3><div class="v2-person-relations">${relations.map(({ relation, person: related }) => `<button type="button" data-v2-related-person="${escapeHtml(related.id)}"><span>${escapeHtml(this.runtime.relationLabel(relation, personId))}</span><b>${escapeHtml(related.display_name)}</b>${relation.needs_review ? '<i>Se över</i>' : '<span></span>'}</button>`).join('') || '<p>Inga strukturerade relationer.</p>'}</div></section>${this.contextHtml(personId)}`;
    this.showDrawer();
    if (updateUrl) this.setRoute('person', person.id);
  }

  openFamily(familyId, { updateUrl = true } = {}) {
    const family = this.runtime.getFamily(familyId);
    if (!family) return;
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">${escapeHtml(family.reference_code || 'Familj')}</p><h2>${escapeHtml(familyLabel(family))}</h2></div><button type="button" data-v2-close-person aria-label="Stäng">×</button></header><p class="drawer-meta">Stabil familjeenhet med ${family.member_count} ${family.member_count === 1 ? 'person' : 'personer'}. Familjen är en grupplänk; släktträdet byggs av personrelationerna.</p>${familyTree(family)}${family.needs_review && family.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(family.review_comment)}</p></section>` : ''}`;
    this.showDrawer();
    if (updateUrl) this.setRoute('family', family.id);
  }

  showDrawer() {
    this.drawer.setAttribute('aria-hidden', 'false');
    this.drawer.classList.add('open');
    document.body.classList.add('drawer-open');
  }

  setRoute(kind, id) {
    const url = new URL(location.href);
    url.searchParams.delete(kind === 'person' ? 'family' : 'person');
    url.searchParams.set(kind, id);
    history.replaceState(null, '', url);
  }

  close() {
    this.drawer.setAttribute('aria-hidden', 'true');
    this.drawer.classList.remove('open');
    document.body.classList.remove('drawer-open');
    this.drawerContent.innerHTML = '';
    const url = new URL(location.href);
    url.searchParams.delete('person');
    url.searchParams.delete('family');
    history.replaceState(null, '', url);
  }
}

export const createPeopleV2Controller = options => new PeopleV2Controller(options);
