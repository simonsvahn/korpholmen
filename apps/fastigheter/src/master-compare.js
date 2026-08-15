const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');

function ownerNames(owners) {
  return owners.length ? owners.map(owner => owner.name).join(', ') : 'Saknas';
}

function associationRole(role) {
  if (role === 'lived_here') return 'Senaste Korpholmenanknytning';
  if (role === 'fastighetsgemenskap') return 'Äldre bred fastighetskoppling';
  return role || 'Koppling';
}

function linkList(items) {
  return items.length ? `<div class="compare-chips">${items.map(item => `<span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(associationRole(item.role))}</small></span>`).join('')}</div>` : '<p class="compare-empty">Inga fristående personkopplingar.</p>';
}

function sourceList(items) {
  return items.length ? `<ul class="compare-sources">${items.map(item => `<li><b>${escapeHtml(item.label)}</b>${item.type ? `<span>${escapeHtml(item.type)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="compare-empty">Ingen källa knuten till de aktiva tidslinjeposterna.</p>';
}

function sourceNames(item, sourceMap) {
  const labels = (item?.source_ids || []).map(id => sourceMap.get(id) || id);
  for (const reference of item?.source_refs || []) {
    if (reference.type === 'human_decision') {
      labels.push(`Mänskligt beslut${reference.date ? ` ${reference.date}` : ''}`);
      continue;
    }
    const filename = String(reference.path || '').split(/[\\/]/).pop();
    if (filename) labels.push(`${filename}${reference.line ? `, rad ${reference.line}` : ''}`);
  }
  return [...new Set(labels)].join(' · ');
}

function rowFact(row) {
  return row.generation2 || row.generation1;
}

function factYear(row) {
  return rowFact(row)?.year || 9999;
}

function compareTimelineRows(left, right) {
  const leftItem = rowFact(left);
  const rightItem = rowFact(right);
  const leftOrder = Number(leftItem?.chronology_order);
  const rightOrder = Number(rightItem?.chronology_order);
  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
  return factYear(left) - factYear(right) || String(leftItem?.id).localeCompare(String(rightItem?.id), 'sv');
}

function amountLabel(item) {
  if (item?.amount === null || item?.amount === undefined || !Number.isFinite(Number(item.amount))) return '';
  const amount = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(Number(item.amount)).replaceAll('\u00a0', ' ');
  const unit = item.currency === 'SEK' ? 'kronor' : item.currency || '';
  return `Belopp: ${amount}${unit ? ` ${unit}` : ''}`;
}

function isOwnerRole(value) {
  return /ägare|ägande|lagfaren/i.test(String(value || ''));
}

function groupSimultaneousOwners(rows) {
  const groups = new Map();
  const result = [];
  for (const row of rows) {
    const item = rowFact(row);
    if (!item?.person || !isOwnerRole(item.role)) {
      result.push(row);
      continue;
    }
    const key = JSON.stringify([
      row.status, item.kind, item.time, item.role, item.chronology_order ?? null,
      [...(item.source_ids || [])].sort(), row.reason, item.needs_review === true, item.review_comment || '',
    ]);
    const group = groups.get(key);
    if (group) {
      group.display_people.push(item.person);
      group.display_ids.push(item.id);
      continue;
    }
    const created = { ...row, display_people: [item.person], display_ids: [item.id] };
    groups.set(key, created);
    result.push(created);
  }
  return result;
}

function statusFact(row, sourceMap) {
  const item = rowFact(row);
  if (!item) return '';
  const people = row.display_people || (item.person ? [item.person] : []);
  const partyCount = Number(item.party_count) || people.length;
  const title = people.length ? people.map(person => person.name).join(', ') : item.label;
  const sources = sourceNames(item, sourceMap);
  const amount = amountLabel(item);
  return `<article class="timeline-status-row">
    <time>${escapeHtml(item.time)}</time>
    <div><b>${escapeHtml(title)}</b><span>${escapeHtml(item.role)}${partyCount > 1 ? ` · ${partyCount} samtidiga ägare` : ''}</span>${amount ? `<span>${escapeHtml(amount)}</span>` : ''}${sources ? `<small>${escapeHtml(sources)}</small>` : ''}${item.needs_review && item.review_comment ? `<p><b>Fördjupa:</b> ${escapeHtml(item.review_comment)}</p>` : ''}<p>${escapeHtml(row.reason)}</p></div>
  </article>`;
}

function statusSection({ title, description, rows, status, sourceMap, collapsible = false }) {
  if (!rows.length) return '';
  const displayRows = groupSimultaneousOwners([...rows].sort(compareTimelineRows));
  const body = `<section class="timeline-status-section ${status}"><header><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><b>${displayRows.length}</b></header><div>${displayRows.map(row => statusFact(row, sourceMap)).join('')}</div></section>`;
  return collapsible ? `<details class="timeline-status-fold"><summary>${escapeHtml(title)} <span>${displayRows.length}</span></summary>${body}</details>` : body;
}

function archiveLabel(types) {
  const labels = {
    'holding-claim': 'innehavsanspråk',
    'event-claim': 'händelseanspråk',
    'manual-claim': 'råuppgifter',
    evidence: 'belägg',
    'audit-finding': 'granskningsfynd',
    'community-link': 'äldre personkopplingar',
    'rejected-claim': 'avförda uppgifter',
  };
  const rows = Object.entries(types).sort((left, right) => right[1] - left[1]);
  return rows.length ? rows.map(([type, count]) => `${count} ${labels[type] || type}`).join(' · ') : 'Inga fastighetsbundna arkivposter';
}

function progressState(row) {
  const counts = row.comparison.timeline_diff.counts;
  if (counts.pending_review) return '<span class="compare-state pending_review">Granskning återstår</span>';
  if (counts.approved_pending) return '<span class="compare-state approved_pending">Godkänd · införs</span>';
  return '<span class="compare-state active">Tidslinje klar</span>';
}

export function renderPropertyComparison(row) {
  const counts = row.comparison.timeline_diff.counts;
  const sourceMap = new Map([...row.generation1.sources, ...row.generation2.sources].map(source => [source.id, source.label]));
  const statusRows = status => row.comparison.timeline_diff.rows.filter(item => item.status === status);
  return `<header class="drawer-header compare-drawer-header"><p class="eyebrow dark">Fastighet ${escapeHtml(row.property_id)}</p><h2>${escapeHtml(row.display_label)}</h2><p>${escapeHtml(row.island || 'Plats ej angiven')}</p></header>
    <section class="timeline-status-overview">
      <div><span>Nuvarande ägare</span><b>${escapeHtml(ownerNames(row.generation2.current_owners))}</b></div>
      <div class="active"><span>Aktivt</span><b>${counts.active}</b></div>
      <div class="approved_pending"><span>Godkänt · väntar</span><b>${counts.approved_pending}</b></div>
      <div class="pending_review"><span>Att granska</span><b>${counts.pending_review}</b></div>
      <div class="archive_only"><span>Endast arkiv</span><b>${counts.archive_only}</b></div>
    </section>
    ${statusSection({ title: 'Aktiv tidslinje', description: 'Det här är de poster som faktiskt visas från den nya Fastighetsmastern.', rows: statusRows('active'), status: 'active', sourceMap })}
    ${statusSection({ title: 'Godkänt – väntar på införande', description: 'Beslutet är sparat. Posterna flyttar till den aktiva tidslinjen när nästa Fastighetsrevision byggs.', rows: statusRows('approved_pending'), status: 'approved_pending', sourceMap })}
    ${statusSection({ title: 'Väntar på granskning', description: 'Bevarade råuppgifter som ännu inte har godkänts, rättats eller avförts.', rows: statusRows('pending_review'), status: 'pending_review', sourceMap })}
    ${statusSection({ title: 'Endast forskningsarkiv', description: 'Uttryckligen avförda, ersatta eller felklassade råuppgifter. De är bevarade men ska inte in i vardagstidslinjen.', rows: statusRows('archive_only'), status: 'archive_only', sourceMap, collapsible: true })}
    <details class="compare-full"><summary>Visa personkopplingar och källöversikt</summary><div class="compare-columns">
      <section class="compare-panel master"><h3>Uttryckliga personkopplingar</h3>${linkList(row.generation2.property_associations)}</section>
      <section class="compare-panel master"><h3>Källor till aktiva poster</h3>${sourceList(row.generation2.sources)}</section>
    </div></details>
    <section class="compare-archive"><h3>Forskningsarkivet är kvar</h3><p>${escapeHtml(archiveLabel(row.comparison.archived_types))}</p><small>Arkivet är spårbar bakgrund, inte automatiskt godkänd masterdata.</small></section>`;
}

export function renderComparisonRows(rows) {
  return rows.map(row => {
    const counts = row.comparison.timeline_diff.counts;
    return `<tr>
      <td><div class="property-open"><b>${escapeHtml(row.display_label)}</b><span>${escapeHtml(row.island || 'Plats ej angiven')}</span></div></td>
      <td>${escapeHtml(ownerNames(row.generation2.current_owners))}</td>
      <td>${progressState(row)}</td>
      <td><b>${counts.active}</b></td>
      <td><b>${counts.approved_pending}</b></td>
      <td><b>${counts.pending_review}</b></td>
      <td><b>${counts.archive_only}</b></td>
      <td><button class="compare-open-button" type="button" data-compare-property="${escapeHtml(row.property_id)}">Visa tidslinjen</button></td>
    </tr>`;
  }).join('');
}

export async function initPropertyMasterComparison({ content, drawer, drawerContent, backdrop, statusNode, toolbar, connectButton, bootstrapButton }) {
  document.body.classList.add('property-master-comparison');
  connectButton.hidden = true;
  bootstrapButton.hidden = true;
  document.querySelector('.site-header h1').textContent = 'Fastigheter · tidslinjestatus';
  document.querySelector('.site-header .intro').textContent = 'Se vad som är aktivt, godkänt, ogranskat eller medvetet arkiverat.';
  statusNode.textContent = 'Läser aktiv master och bevarat arbetsmaterial …';
  statusNode.className = '';
  toolbar.innerHTML = `<label class="field wide">Sök<input id="compare-search" type="search" placeholder="Fastighet, ö eller ägare …"></label>
    <label class="field">Visa<select id="compare-filter"><option value="">Alla fastigheter</option><option value="pending_review">Väntar på granskning</option><option value="approved_pending">Godkänt men ej infört</option><option value="archive_only">Har avförda arkivposter</option><option value="complete">Tidslinje klar</option></select></label>
    <a class="compare-normal-link" href="./">Öppna vanliga appen</a><output id="filter-count" aria-live="polite"></output>`;
  const response = await fetch('/privat/property-master/comparison.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Statusunderlaget kunde inte läsas (${response.status}). Starta den lokala Fastigheter-servern.`);
  const data = await response.json();
  if (data.status !== 'read_only_timeline_status' || !Array.isArray(data.rows)) throw new Error('Statusunderlaget har fel format.');
  let query = '';
  let filter = '';
  const render = () => {
    const needle = normalize(query);
    const rows = data.rows.filter(row => {
      if (needle && !normalize([row.display_label, row.property_id, row.island, ...row.generation2.current_owners.map(owner => owner.name)].join(' ')).includes(needle)) return false;
      const diff = row.comparison.timeline_diff;
      if (filter === 'complete') return diff.is_complete;
      if (filter && !diff.counts[filter]) return false;
      return true;
    });
    toolbar.querySelector('#filter-count').textContent = `${rows.length} av ${data.rows.length} fastigheter`;
    content.innerHTML = `<section class="register-view compare-register">
      <div class="compare-summary">
        <div><span>Fastigheter</span><b>${data.summary.properties}</b></div>
        <div class="active"><span>Aktiva poster</span><b>${data.summary.active_timeline_rows}</b></div>
        <div class="approved_pending"><span>Godkänt · väntar</span><b>${data.summary.approved_pending_timeline_rows}</b></div>
        <div class="pending_review"><span>Att granska</span><b>${data.summary.pending_review_timeline_rows}</b></div>
        <div class="archive_only"><span>Endast arkiv</span><b>${data.summary.archive_only_timeline_rows}</b></div>
        <div><span>Klara fastigheter</span><b>${data.summary.completed_properties}</b></div>
      </div>
      <div class="compare-explanation"><p><b>Tidslinjen är byggd.</b> Grönt är aktivt i Fastighetsmastern. Blått är godkänt och väntar bara på nästa revision. Gult behöver granskas. Grått är medvetet kvar enbart i forskningsarkivet. Vyn uppdateras när servern läser en ny masterrevision eller ett nytt sparat beslut.</p></div>
      <div class="table-shell"><table class="compare-table"><thead><tr><th>Fastighet</th><th>Nuvarande ägare</th><th>Status</th><th>Aktivt</th><th>Godkänt väntar</th><th>Att granska</th><th>Endast arkiv</th><th>Öppna</th></tr></thead><tbody>${renderComparisonRows(rows)}</tbody></table></div>
      ${rows.length ? '' : '<p class="empty-row">Inga fastigheter matchar filtret.</p>'}
    </section>`;
  };
  const close = () => {
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
    drawerContent.innerHTML = '';
    const url = new URL(location.href);
    url.searchParams.delete('property');
    history.replaceState(null, '', url);
  };
  const open = propertyId => {
    const row = data.rows.find(item => item.property_id === propertyId);
    if (!row) return;
    drawerContent.innerHTML = renderPropertyComparison(row);
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    const url = new URL(location.href);
    url.searchParams.set('property', propertyId);
    history.replaceState(null, '', url);
  };
  content.addEventListener('click', event => {
    const button = event.target.closest('[data-compare-property]');
    if (button) open(button.dataset.compareProperty);
  });
  drawer.addEventListener('click', event => { if (event.target.closest('[data-action="close"]')) close(); });
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  toolbar.querySelector('#compare-search').addEventListener('input', event => { query = event.target.value; render(); });
  toolbar.querySelector('#compare-filter').addEventListener('change', event => { filter = event.target.value; render(); });
  render();
  statusNode.textContent = `Skrivskyddad statusvy · Fastighetsmaster revision ${data.generation2.master_revision} · Personmaster revision ${data.people.master_revision}`;
  statusNode.className = 'status-ok';
  const requested = new URL(location.href).searchParams.get('property');
  if (requested) open(requested);
  return data;
}
