const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

const timeLabel = time => time?.original_text || time?.start_min || time?.start_max || time?.end_min || time?.end_max || '';
const levelLabel = value => value === 'senior' ? 'Senior' : value === 'junior' ? 'Junior' : 'Ej angivet';
const lifeLabel = person => person.living === true ? 'Levande' : person.living === false ? 'Avliden' : 'Okänd livsstatus';
const familyLabel = family => family.display_name || family.reference_code || 'Familj';

function personButton(person, { relation = '', compact = false } = {}) {
  return `<button type="button" class="v2-tree-person${compact ? ' compact' : ''}" data-v2-related-person="${escapeHtml(person.id)}" aria-label="${escapeHtml(`${person.display_name}. ${lifeLabel(person)}`)}">${relation ? `<span>${escapeHtml(relation)}</span>` : ''}<b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}</button>`;
}

function familyTree(family) {
  const anchors = family.anchors || [];
  const children = family.children || [];
  return `<div class="v2-family-tree" aria-label="Familjeträd för ${escapeHtml(familyLabel(family))}"><div class="v2-tree-parents">${anchors.map(person => personButton(person)).join('<span class="v2-partner-line" aria-label="partner">—</span>') || '<p>Ankarpersoner saknas.</p>'}</div>${children.length ? `<div class="v2-tree-stem" aria-hidden="true"></div><div class="v2-tree-children">${children.map(person => personButton(person, { compact: true })).join('')}</div>` : '<p class="v2-no-children">Inga gemensamma barn ingår i familjeenheten.</p>'}</div>`;
}

function kinshipPersonButton(person) {
  return `<button type="button" class="v2-kinship-person" data-v2-person="${escapeHtml(person.id)}" aria-label="Öppna ${escapeHtml(person.display_name)}"><b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}</button>`;
}

function sameHousehold(family, householdIds) {
  const anchors = family.anchor_person_ids || [];
  return anchors.length > 1 && anchors.every(personId => householdIds.includes(personId));
}

function householdFamilyLabels(families, householdIds) {
  const matching = families.filter(family => sameHousehold(family, householdIds));
  if (!matching.length) return '';
  return `<div class="v2-kinship-family-labels" aria-label="Familjeenheter">${matching.map(family => `<button type="button" data-v2-family="${escapeHtml(family.id)}">${escapeHtml(familyLabel(family))}</button>`).join('')}</div>`;
}

function kinshipRootPeople(component, graph) {
  return [...component]
    .map(id => graph.byId.get(id))
    .filter(Boolean)
    .filter(person => !(graph.parents.get(person.id) || []).some(link => component.has(link.id)))
    .sort((left, right) => left.display_name.localeCompare(right.display_name, 'sv'));
}

function kinshipComponentTitle(component, graph) {
  const roots = kinshipRootPeople(component, graph);
  const people = roots.length ? roots : [...component].map(id => graph.byId.get(id)).filter(Boolean);
  const names = people.slice(0, 3).map(person => person.display_name);
  return `${names.join(' · ')}${people.length > 3 ? ` · +${people.length - 3}` : ''}`;
}

function renderKinshipBranch(personId, component, visited, graph, families, uncertain = false) {
  if (visited.has(personId)) return '';
  const person = graph.byId.get(personId);
  if (!person) return '';
  visited.add(personId);
  const partnerLinks = (graph.partners.get(personId) || [])
    .filter(link => component.has(link.id) && !visited.has(link.id))
    .sort((left, right) => (left.relation.kind === 'tidigare') - (right.relation.kind === 'tidigare') || graph.byId.get(left.id).display_name.localeCompare(graph.byId.get(right.id).display_name, 'sv'));
  partnerLinks.forEach(link => visited.add(link.id));
  const householdIds = [personId, ...partnerLinks.map(link => link.id)];
  const childIds = [...new Set(householdIds.flatMap(id => (graph.children.get(id) || []).map(link => link.id)))]
    .filter(id => component.has(id) && !visited.has(id))
    .sort((left, right) => graph.byId.get(left).display_name.localeCompare(graph.byId.get(right).display_name, 'sv'));
  const childHtml = childIds.map(childId => {
    const links = householdIds.flatMap(parentId => (graph.children.get(parentId) || []).filter(link => link.id === childId));
    return renderKinshipBranch(childId, component, visited, graph, families, links.some(link => link.relation.needs_review));
  }).join('');
  const household = `<div class="v2-kinship-household-block">${householdFamilyLabels(families, householdIds)}<div class="v2-kinship-household">${kinshipPersonButton(person)}${partnerLinks.map(link => {
    const marker = link.relation.kind === 'tidigare' ? 'förr' : link.relation.kind === 'coparent' ? '+' : '—';
    const label = link.relation.kind === 'tidigare' ? 'tidigare partner' : link.relation.kind === 'coparent' ? 'har barn tillsammans' : 'partner';
    return `<span class="v2-kinship-partner ${escapeHtml(link.relation.kind)}" aria-label="${label}">${marker}</span>${kinshipPersonButton(graph.byId.get(link.id))}`;
  }).join('')}</div></div>`;
  return `<div class="v2-kinship-node${uncertain ? ' uncertain' : ''}">${household}${childHtml ? `<div class="v2-kinship-stem" aria-hidden="true"></div><div class="v2-kinship-children">${childHtml}</div>` : ''}</div>`;
}

function renderKinshipComponent(group, graph, index) {
  const { component, families = [], family_count: familyCount = 0, generation_count: generationCount = null } = group;
  const visited = new Set();
  const roots = kinshipRootPeople(component, graph);
  const branches = [];
  for (const root of roots) if (!visited.has(root.id)) branches.push(renderKinshipBranch(root.id, component, visited, graph, families));
  for (const id of component) if (!visited.has(id)) branches.push(renderKinshipBranch(id, component, visited, graph, families));
  const familySummary = familyCount ? `${familyCount} ${familyCount === 1 ? 'familj' : 'familjer'} · ` : '';
  const title = group.title || kinshipComponentTitle(component, graph);
  const label = group.title ? `Släktgren ${index + 1}` : `Släktträd ${index + 1}`;
  const summary = group.title ? `${familySummary}${generationCount} led · ${component.size} personer` : `${component.size} personer`;
  return `<article class="v2-kinship-component" style="--tree-accent:hsl(${[205, 145, 18, 278, 188, 332][index % 6]} 42% 42%)"><header><div><small>${label}</small><h3>${escapeHtml(title)}</h3></div><span>${summary}</span></header><div class="v2-kinship-canvas">${branches.join('')}</div></article>`;
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
    this.lineageStart = 1;
    this.lineageDepth = '';
    this.mode = 'people';
  }

  configureShell() {
    document.documentElement.dataset.peopleV2 = 'true';
    document.querySelector('.site-header h1').textContent = 'Personer & familjer';
    document.querySelector('.site-header .intro').textContent = 'Personer, familjer och släkter visas från den aktiva personmasterns stabila ID:n och faktiska relationer.';
    document.querySelector('.family-model')?.setAttribute('hidden', '');
    document.querySelector('main .legend')?.setAttribute('hidden', '');
    const requestedMode = new URL(location.href).searchParams.get('view');
    if (['people', 'families', 'kinship', 'lineages'].includes(requestedMode)) this.mode = requestedMode;
    const subnav = document.querySelector('.app-subnav .kh-tabs');
    subnav.setAttribute('role', 'tablist');
    subnav.setAttribute('aria-label', 'Välj vy');
    subnav.innerHTML = `<button type="button" role="tab" data-v2-mode="kinship">Släkter</button><button type="button" role="tab" data-v2-mode="lineages">Släktträd</button><button type="button" role="tab" data-v2-mode="families">Familjer</button><button type="button" role="tab" data-v2-mode="people">Personer</button>`;
    const toolbar = document.querySelector('.toolbar');
    toolbar.innerHTML = `<div class="v2-people-toolbar"><label>Sök<input id="v2-people-search" type="search" placeholder="Namn eller klubbnamn …"></label><label class="v2-person-filter">Livsstatus<select id="v2-people-life"><option value="">Alla</option><option value="living">Levande</option><option value="dead">Avlidna</option><option value="unknown">Okänd</option></select></label><label class="v2-person-filter">Medlemsnivå<select id="v2-people-level"><option value="">Alla</option><option value="senior">Seniorer</option><option value="junior">Juniorer</option><option value="none">Ej angivet</option></select></label><label class="v2-lineage-filter" hidden>Översta led<select id="v2-lineage-start"><option value="1">Äldsta kända</option><option value="2">Led 2</option><option value="3">Led 3</option><option value="4">Led 4</option><option value="5">Led 5</option></select></label><label class="v2-lineage-filter" hidden>Visa djup<select id="v2-lineage-depth"><option value="">Alla återstående</option><option value="1">1 led</option><option value="2">2 led</option><option value="3">3 led</option></select></label><output id="v2-people-count"></output></div>`;
    toolbar.querySelector('#v2-people-search').addEventListener('input', event => { this.search = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-life').addEventListener('change', event => { this.life = event.target.value; this.render(); });
    toolbar.querySelector('#v2-people-level').addEventListener('change', event => { this.level = event.target.value; this.render(); });
    toolbar.querySelector('#v2-lineage-start').addEventListener('change', event => { this.lineageStart = Number(event.target.value) || 1; this.render(); });
    toolbar.querySelector('#v2-lineage-depth').addEventListener('change', event => { this.lineageDepth = event.target.value; this.render(); });
    subnav.addEventListener('click', event => {
      const button = event.target.closest('[data-v2-mode]');
      if (!button) return;
      this.mode = button.dataset.v2Mode;
      this.close();
      const url = new URL(location.href);
      if (this.mode === 'people') url.searchParams.delete('view');
      else url.searchParams.set('view', this.mode);
      history.replaceState(null, '', url);
      this.render();
    });
    this.content.addEventListener('click', event => {
      const person = event.target.closest('[data-v2-person]');
      const family = event.target.closest('[data-v2-family]');
      if (person) this.open(person.dataset.v2Person);
      if (family) this.openFamily(family.dataset.v2Family);
    });
    this.drawer.addEventListener('click', event => {
      if (event.target.closest('[data-v2-close-person], [data-action="close-drawer"]')) this.close();
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

  visibleKinship() {
    const kinship = this.runtime.kinship();
    const needle = normalize(this.search);
    if (!needle) return kinship;
    const matchingIds = new Set(this.runtime.listPeople().filter(person => normalize([person.display_name, person.club_name, ...(person.aliases || []), person.context_note].join(' ')).includes(needle)).map(person => person.id));
    return {
      ...kinship,
      connected: kinship.connected.filter(component => [...component].some(id => matchingIds.has(id))),
      lineages: kinship.lineages.filter(group => [...group.component].some(id => matchingIds.has(id))),
      isolated: kinship.isolated.filter(component => [...component].some(id => matchingIds.has(id))),
    };
  }

  render() {
    const all = this.runtime.listPeople();
    const tabs = document.querySelectorAll('.app-subnav [data-v2-mode]');
    tabs.forEach(button => {
      const selected = button.dataset.v2Mode === this.mode;
      button.setAttribute('aria-selected', String(selected));
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.v2-person-filter').forEach(node => { node.hidden = this.mode !== 'people'; });
    document.querySelectorAll('.v2-lineage-filter').forEach(node => { node.hidden = this.mode !== 'lineages'; });
    const search = document.querySelector('#v2-people-search');
    if (search) search.placeholder = ['kinship', 'lineages'].includes(this.mode) ? 'Hitta en person i släktträden …' : this.mode === 'families' ? 'Familj eller person …' : 'Namn, klubbnamn eller kontext …';
    if (!all.length) {
      this.content.innerHTML = '<section class="empty"><h2>Ingen verifierad Personmaster på enheten ännu</h2><p>Anslut Dropbox för att läsa den aktiva V2-mastern.</p></section>';
      return;
    }
    if (this.mode === 'lineages') this.renderLineages();
    else if (this.mode === 'kinship') this.renderKinship();
    else if (this.mode === 'families') this.renderFamilies();
    else this.renderPeople();
  }

  renderPeople() {
    const all = this.runtime.listPeople();
    const people = this.visiblePeople();
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${people.length} av ${all.length} personer`;
    this.content.innerHTML = `<section class="v2-people-register"><header><div><p class="eyebrow dark">Aktiv personmaster</p><h2>Personer</h2></div><p>Öppna en person för närmaste familj, relationer och övriga sammanhang.</p></header><div class="v2-people-list">${people.map(person => `<button type="button" class="v2-person-row" data-v2-person="${escapeHtml(person.id)}"><span><b>${escapeHtml(person.display_name)}</b>${person.club_name ? `<i>${escapeHtml(person.club_name)}</i>` : ''}</span><span>${escapeHtml(levelLabel(person.membership_level))}</span><span>${escapeHtml(lifeLabel(person))}</span>${person.needs_review ? '<strong>Se över</strong>' : '<span></span>'}</button>`).join('')}</div>${people.length ? '' : '<p>Inga personer matchar filtren.</p>'}</section>`;
  }

  renderFamilies() {
    const all = this.runtime.listFamilies();
    const families = this.visibleFamilies();
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${families.length} av ${all.length} familjer`;
    this.content.innerHTML = `<section class="v2-people-register v2-family-register"><header><div><p class="eyebrow dark">Stabila familjeenheter</p><h2>Familjer</h2></div><p>Familjer används som grupplänk; relationerna avgör trädet.</p></header><div class="v2-family-list">${families.map(family => `<button type="button" class="v2-family-row" data-v2-family="${escapeHtml(family.id)}"><span><small>${escapeHtml(family.reference_code || '')}</small><b>${escapeHtml(familyLabel(family))}</b></span><span>${family.anchors.map(person => escapeHtml(person.display_name)).join(' · ') || 'Ankarperson saknas'}</span><span>${family.children.length ? `${family.children.length} gemensamma barn` : 'Inga barn i enheten'}</span>${family.needs_review ? '<strong>Se över</strong>' : '<span></span>'}</button>`).join('')}</div>${families.length ? '' : '<p>Inga familjer matchar sökningen.</p>'}</section>`;
  }

  renderKinship() {
    const kinship = this.visibleKinship();
    const connectedPeople = kinship.connected.reduce((sum, component) => sum + component.size, 0);
    const isolatedPeople = kinship.isolated.flatMap(component => [...component].map(id => kinship.graph.byId.get(id)).filter(Boolean));
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${kinship.connected.length} träd · ${connectedPeople} kopplade`;
    this.content.innerHTML = `<section class="v2-people-register v2-kinship-register"><header><div><p class="eyebrow dark">Faktiska relationer</p><h2>Släkter</h2></div><p>Partner visas tillsammans och barn under sina föräldrar. Inga gamla släktkretsar styr träden.</p></header><div class="v2-kinship-forest">${kinship.connected.map((component, index) => renderKinshipComponent({ component }, kinship.graph, index)).join('') || '<p>Inga sammanhängande släktträd matchar sökningen.</p>'}</div>${isolatedPeople.length ? `<section class="v2-kinship-isolated"><h3>Utan registrerad personrelation <span>${isolatedPeople.length}</span></h3><div>${isolatedPeople.sort((left, right) => left.display_name.localeCompare(right.display_name, 'sv')).map(kinshipPersonButton).join('')}</div></section>` : ''}</section>`;
  }

  renderLineages() {
    const kinship = this.visibleKinship();
    const lineages = kinship.lineages
      .map(group => this.runtime.lineageWindow(group, { startGeneration: this.lineageStart, generationDepth: this.lineageDepth }))
      .filter(group => group.component.size);
    const peopleIds = new Set(lineages.flatMap(group => [...group.component]));
    const count = document.querySelector('#v2-people-count');
    if (count) count.textContent = `${lineages.length} grenar · ${peopleIds.size} personer`;
    this.content.innerHTML = `<section class="v2-people-register v2-kinship-register v2-lineage-register"><header><div><p class="eyebrow dark">Familjer över flera led</p><h2>Släktträd</h2></div><p>Ett barn som senare bildar en ny familj förbinder familjerna till en läsbar släktgren.</p></header><div class="v2-kinship-forest">${lineages.map((group, index) => renderKinshipComponent(group, kinship.graph, index)).join('') || '<p>Inga familjebaserade släktgrenar matchar inställningen.</p>'}</div></section>`;
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
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">Personmaster</p><h2>${escapeHtml(person.display_name)}</h2>${person.club_name ? `<p><i>${escapeHtml(person.club_name)}</i></p>` : ''}</div></header><dl class="v2-person-facts"><div><dt>Livsstatus</dt><dd>${escapeHtml(lifeLabel(person))}</dd></div><div><dt>Född</dt><dd>${escapeHtml(timeLabel(person.birth_time) || 'Ej angivet')}</dd></div><div><dt>Död</dt><dd>${escapeHtml(timeLabel(person.death_time) || '—')}</dd></div><div><dt>Medlemsnivå</dt><dd>${escapeHtml(levelLabel(person.membership_level))}</dd></div>${person.membership_form ? `<div><dt>Medlemsform</dt><dd>${escapeHtml(person.membership_form)}</dd></div>` : ''}${person.induction_year ? `<div><dt>Invalsår</dt><dd>${escapeHtml(person.induction_year)}</dd></div>` : ''}</dl><div class="v2-master-links"><a href="../matrikel/?person=${encodeURIComponent(person.id)}">Visa i Matrikel →</a></div>${person.aliases?.length ? `<section class="drawer-section"><h3>Andra namnformer</h3><p>${person.aliases.map(escapeHtml).join(', ')}</p></section>` : ''}${person.context_note ? `<section class="drawer-section"><h3>Kontext</h3><p>${escapeHtml(person.context_note)}</p></section>` : ''}${person.needs_review && person.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(person.review_comment)}</p></section>` : ''}<section class="drawer-section"><h3>Närmaste familj</h3>${families.map(family => `<article class="v2-drawer-family"><button type="button" class="v2-family-title" data-v2-related-family="${escapeHtml(family.id)}"><b>${escapeHtml(familyLabel(family))}</b></button>${familyTree(family)}</article>`).join('') || '<p>Personen ingår inte i någon stabil familjeenhet ännu.</p>'}</section><section class="drawer-section"><h3>Direkta relationer</h3><div class="v2-person-relations">${relations.map(({ relation, person: related }) => `<button type="button" data-v2-related-person="${escapeHtml(related.id)}"><span>${escapeHtml(this.runtime.relationLabel(relation, personId))}</span><b>${escapeHtml(related.display_name)}</b>${relation.needs_review ? '<i>Se över</i>' : '<span></span>'}</button>`).join('') || '<p>Inga strukturerade relationer.</p>'}</div></section>${this.contextHtml(personId)}`;
    this.showDrawer();
    if (updateUrl) this.setRoute('person', person.id);
  }

  openFamily(familyId, { updateUrl = true } = {}) {
    const family = this.runtime.getFamily(familyId);
    if (!family) return;
    this.drawerContent.innerHTML = `<header class="drawer-heading"><div><p class="eyebrow dark">${escapeHtml(family.reference_code || 'Familj')}</p><h2>${escapeHtml(familyLabel(family))}</h2></div></header><p class="drawer-meta">Stabil familjeenhet med ${family.member_count} ${family.member_count === 1 ? 'person' : 'personer'}. Familjen är en grupplänk; personrelationerna avgör vilka som visas.</p>${familyTree(family)}${family.needs_review && family.review_comment ? `<section class="drawer-section v2-review"><h3>Se över</h3><p>${escapeHtml(family.review_comment)}</p></section>` : ''}`;
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
