import {
  DropboxTransport,
  IndexedDBStore,
  MemoryStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createBatch,
  exchangeDropboxRefreshToken,
  openSlaktlandskapDB,
  validateOperation,
} from '../../../packages/core/data-layer.js';
import {
  DROPBOX_CLIENT_ID,
  DROPBOX_SCOPES,
  LOCAL_BOOTSTRAP_URL,
  LOCAL_IMAGE_BASE_URL,
  LOCAL_IMAGE_MANIFEST_URL,
} from './config.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const drawer = $('#boat-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/batregister/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:batregister-2026-08-01';
const IMAGE_BOOTSTRAP_META = 'bootstrap:batregister-images-2026-08-01';
const MATRIKEL_PEOPLE_META = 'cache:matrikel-people';
const imageUrls = new Map();
const imageLoads = new Map();

let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedBoatId = null;
let matrikelPeople = [];

const ui = { search: '', type: '', person: new URL(location.href).searchParams.get('person') || '', family: '', nameStatus: '', imageOnly: false, grouping: 'none' };
const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const unique = values => [...new Set(values.filter(Boolean))];
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const slug = value => normalize(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'bat';
const isOfflineError = error => navigator.onLine === false || error instanceof TypeError || /failed to fetch|load failed|networkerror|internetanslutning|network connection/i.test(String(error?.message || error));

async function mapConcurrent(values, limit, mapper) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      await mapper(values[index], index);
    }
  }));
}

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

function deviceId() {
  const key = 'korpholmen:batregister-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = `bat-web-${crypto.randomUUID()}`; localStorage.setItem(key, id); }
  return id;
}

function redirectUri() {
  return new URL(isSourceTree ? '../../' : '../', location.href).href;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (hadController) {
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      }, { once: true });
    }
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (error) {
    console.warn('Appskalet kunde inte uppdateras', error);
    return null;
  }
}
function boatRecords() { return repository.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>String(a.namn).localeCompare(String(b.namn),'sv')); }
function linkRecords() { return repository.listEntities('boat-person-link').map(entity => ({ id: entity.entity_id, ...entity.fields })); }
function linksForBoat(id) { return linkRecords().filter(link => link.boat_id === id); }
function familyRecords() { return repository.listEntities('family').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>String(a.name).localeCompare(String(b.name),'sv')); }
function familyLinkRecords() { return repository.listEntities('boat-family-link').map(entity => ({ id: entity.entity_id, ...entity.fields })); }
function familyLinksForBoat(id) { return familyLinkRecords().filter(link => link.boat_id === id); }
function familyMembers(family) {
  const ids = new Set(family.explicit_person_ids || []);
  for (const person of matrikelPeople) if ((family.match_family_labels || []).includes(person.family)) ids.add(person.id);
  return [...ids].map(id => matrikelPeople.find(person => person.id === id)).filter(Boolean).sort((a,b)=>a.display_name.localeCompare(b.display_name,'sv'));
}
function linkedFamilyNames(boatId) { return familyLinksForBoat(boatId).map(link => link.family_name).filter(Boolean); }
function linkedNames(boatId) {
  return [...linksForBoat(boatId).map(link => link.person_display_name), ...linkedFamilyNames(boatId)].filter(Boolean);
}

function optionList(select, values, label) {
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(label)}</option>${values.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  select.value = values.includes(current) ? current : '';
}

function personFilterOptions() {
  const peopleById = new Map(matrikelPeople.map((person) => [person.id, person]));
  const options = new Map();
  for (const link of linkRecords()) {
    options.set(link.person_id, peopleById.get(link.person_id)?.display_name || link.person_display_name || link.person_id);
  }
  return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sv'));
}

function filteredBoats() {
  const query = normalize(ui.search);
  return boatRecords().filter(boat => {
    if (ui.type && boat.typ !== ui.type) return false;
    if (ui.person && !linksForBoat(boat.id).some((link) => link.person_id === ui.person)) return false;
    if (ui.family && ![boat.slakt, ...linkedFamilyNames(boat.id)].includes(ui.family)) return false;
    if (ui.nameStatus && boat.namnstatus !== ui.nameStatus) return false;
    if (ui.imageOnly && !(boat.images || []).length) return false;
    if (query && !normalize([boat.namn, boat.dopnamn, boat.modell, boat.agare, boat.motor, boat.slakt, boat.island_connection, ...linkedNames(boat.id), ...(boat.kallor_text || [])].join(' ')).includes(query)) return false;
    return true;
  });
}

function era(boat) {
  const year = Number(boat.ar || boat.dopar);
  if (!year) return 'År okänt';
  return `${Math.floor(year / 10) * 10}-talet`;
}

function groupBoats(boats) {
  const key = ui.grouping === 'family' ? boat => linkedFamilyNames(boat.id).join(' / ') || boat.slakt || 'Övriga och okända'
    : ui.grouping === 'type' ? boat => boat.typ || 'Typ okänd'
      : ui.grouping === 'era' ? era : () => 'Alla båtar';
  const groups = new Map();
  for (const boat of boats) { const label = key(boat); if (!groups.has(label)) groups.set(label, []); groups.get(label).push(boat); }
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b,'sv'));
}

function imageRef(boat, role = 'thumb') {
  const image = boat.images?.[0];
  if (!image) return null;
  return image[role] || image.full || image.thumb || null;
}

function imageMarkup(boat) {
  const ref = imageRef(boat, 'thumb');
  if (!ref) return '<div class="image-placeholder">Bild saknas</div>';
  const local = isSourceTree && ref.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(ref.filename)}` : '';
  const cached = imageUrls.get(ref.dropbox_path);
  const source = local || cached || '';
  return `<img class="boat-image" alt="${escapeHtml(boat.namn || 'Båt')}" ${source ? `src="${escapeHtml(source)}"` : ''} data-image-path="${escapeHtml(ref.dropbox_path || '')}" style="${boat.images?.[0]?.focus ? `object-position:${escapeHtml(boat.images[0].focus)}` : ''}">`;
}

function card(boat) {
  const links = linksForBoat(boat.id);
  const familyLinks = familyLinksForBoat(boat.id);
  const connectionCount = links.length + familyLinks.length;
  return `<button class="boat-card" type="button" data-boat-id="${escapeHtml(boat.id)}">
    ${imageMarkup(boat)}${connectionCount ? `<span class="linked-count">${connectionCount} koppl.</span>` : ''}
    <span class="boat-copy"><h3>${escapeHtml(boat.namn || 'Namn okänt')}</h3>
      <p>${escapeHtml([boat.modell, boat.ar].filter(Boolean).join(' · ') || 'Modell och år saknas')}</p>
      <p>${escapeHtml(boat.agare || 'Ägare/anknytning saknas')}</p>
      <span class="chips">${boat.typ ? `<span class="chip">${escapeHtml(boat.typ)}</span>` : ''}${boat.slakt ? `<span class="chip">${escapeHtml(boat.slakt)}</span>` : ''}${familyLinks.map(link=>`<span class="chip family-chip">${escapeHtml(link.family_name)}</span>`).join('')}${boat.island_connection ? `<span class="chip context-chip">${escapeHtml(boat.island_connection)}</span>` : ''}${boat.namnstatus === 'dopnamn' ? '<span class="chip warn">Endast dopnamn</span>' : ''}</span>
    </span></button>`;
}

async function cachedBlob(path, transport = null) {
  if (!path) return null;
  if (imageLoads.has(path)) return imageLoads.get(path);
  const promise = (async () => {
    let blob = await store.getBlob(path);
    if (!blob && transport) {
      blob = await transport.getBlob(path);
      await store.putBlob(path, blob);
    }
    return blob;
  })().finally(() => imageLoads.delete(path));
  imageLoads.set(path, promise);
  return promise;
}

function objectUrl(path, blob) {
  let url = imageUrls.get(path);
  if (!url && blob) {
    url = URL.createObjectURL(blob);
    imageUrls.set(path, url);
  }
  return url || '';
}

async function hydrateImages(scope = document) {
  if (isSourceTree) return;
  const nodes = [...scope.querySelectorAll('img[data-image-path]')].filter(node => node.dataset.imagePath && !node.src);
  const transport = accessToken && navigator.onLine !== false
    ? new DropboxTransport({ accessToken, id: 'dropbox-batregister-images', opsRoot: '/batregister/ops' })
    : null;
  await mapConcurrent(nodes, 6, async node => {
    const path = node.dataset.imagePath;
    try {
      const blob = await cachedBlob(path, transport);
      if (blob && node.isConnected) node.src = objectUrl(path, blob);
    } catch (error) {
      if (!isOfflineError(error)) node.alt = `Bild kunde inte hämtas: ${error.message}`;
    }
  });
}

function allImagePaths() {
  return unique(boatRecords().flatMap(boat => (boat.images || []).flatMap(image => [image.thumb?.dropbox_path, image.full?.dropbox_path])));
}

async function cacheAllBoatImages(transport) {
  const paths = allImagePaths();
  let downloaded = 0;
  await mapConcurrent(paths, 4, async path => {
    if (await store.getBlob(path)) return;
    await cachedBlob(path, transport);
    downloaded += 1;
    if (downloaded === 1 || downloaded % 10 === 0) setStatus(`Säkrar bilder för offline-läge · ${downloaded}/${paths.length}`);
  });
  return { total: paths.length, downloaded };
}

async function uploadPendingImages(transport) {
  const pending = await store.listPendingBlobs();
  let uploaded = 0;
  for (const entry of pending) {
    await transport.putBlobImmutable(entry.key, entry.value);
    await store.markBlobUploaded(entry.key);
    uploaded += 1;
  }
  return uploaded;
}

function render() {
  const all = boatRecords();
  optionList($('#type-filter'), unique(all.map(boat=>boat.typ)).sort((a,b)=>a.localeCompare(b,'sv')), 'Alla typer');
  const personOptions = personFilterOptions();
  $('#person-filter').innerHTML = '<option value="">Alla personer</option>' + personOptions.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
  $('#person-filter').value = personOptions.some(([id]) => id === ui.person) ? ui.person : '';
  optionList($('#family-filter'), unique([...all.map(boat=>boat.slakt), ...familyLinkRecords().map(link=>link.family_name)]).sort((a,b)=>a.localeCompare(b,'sv')), 'Alla familjegrenar');
  const shown = filteredBoats();
  $('#filter-count').textContent = `${shown.length} av ${all.length} båtar`;
  if (!all.length) {
    content.innerHTML = `<section class="empty"><h2>Ingen privat båtdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta mastern. Den lokala arbetskopian kan aktivera den låsta startkopian.</p></section>`;
    return;
  }
  content.innerHTML = groupBoats(shown).map(([label, boats])=>`<section class="group"><h2>${escapeHtml(label)} <small>(${boats.length})</small></h2><div class="boat-grid">${boats.map(card).join('')}</div></section>`).join('') || '<p>Inga båtar matchar filtren.</p>';
  hydrateImages(content);
  if (selectedBoatId) renderDrawer(selectedBoatId);
}

const textField = (label, field, value, className='') => `<label class="${className}">${label}<input data-boat-field="${field}" value="${escapeHtml(value ?? '')}"></label>`;
const numberField = (label, field, value, step='1') => `<label>${label}<input type="number" step="${step}" data-boat-field="${field}" value="${value ?? ''}"></label>`;

function renderDrawer(id) {
  const boat = boatRecords().find(item => item.id === id);
  if (!boat) return closeDrawer();
  const links = linksForBoat(id);
  const familyLinks = familyLinksForBoat(id);
  const families = familyRecords();
  const fullRef = imageRef(boat, 'full');
  const local = isSourceTree && fullRef?.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(fullRef.filename)}` : '';
  const cached = fullRef?.dropbox_path ? imageUrls.get(fullRef.dropbox_path) : '';
  const image = fullRef ? `<img class="drawer-image" alt="${escapeHtml(boat.namn)}" ${local || cached ? `src="${escapeHtml(local || cached)}"` : ''} data-image-path="${escapeHtml(fullRef.dropbox_path || '')}">` : '';
  drawerContent.innerHTML = `<h2 class="drawer-title">${escapeHtml(boat.namn || 'Namn okänt')}</h2>${image}
    <div class="edit-grid">
      ${textField('Namn','namn',boat.namn)}
      <label>Namnstatus<select data-boat-field="namnstatus"><option value="namn" ${boat.namnstatus==='namn'?'selected':''}>Känt namn</option><option value="dopnamn" ${boat.namnstatus==='dopnamn'?'selected':''}>Endast dopnamn</option></select></label>
      ${textField('Dopnamn','dopnamn',boat.dopnamn)}${textField('Önskat namn','onskat_namn',boat.onskat_namn)}
      ${textField('Typ','typ',boat.typ)}${textField('Modell','modell',boat.modell)}
      ${numberField('År','ar',boat.ar)}${numberField('Längd (m)','langd_m',boat.langd_m,'0.1')}
      ${textField('Motor','motor',boat.motor)}${textField('Historisk släkt/grupp','slakt',boat.slakt)}
      ${textField('Period','period',boat.period,'span-2')}${textField('Ägare/anknytning','agare',boat.agare,'span-2')}
      ${textField('Tidigare namn, kommaseparerade','tidigare_namn',(boat.tidigare_namn||[]).join(', '),'span-2')}
      ${textField('Senare namn, kommaseparerade','senare_namn',(boat.senare_namn||[]).join(', '),'span-2')}
    </div>
    <section class="drawer-section"><h3>Kopplingar till Matrikeln</h3><p class="section-help">Använd person när en bestämd ägare eller brukare är känd. Använd familjegren bara när källan faktiskt gäller familjen som helhet.</p>
      <div class="link-list">
        ${links.map(link=>`<div class="link-row"><span><a href="../matrikel/?person=${encodeURIComponent(link.person_id)}"><b>${escapeHtml(link.person_display_name || link.person_id)}</b></a><br><small>Person · ${escapeHtml(link.role || '')}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-person-link">Ta bort</button></div>`).join('')}
        ${familyLinks.map(link=>{const family=families.find(item=>item.id===link.family_id);const members=family?familyMembers(family):[];return `<div class="link-row family-row"><span><b>${escapeHtml(link.family_name || link.family_id)}</b><br><small>Familjegren · ${escapeHtml(link.role || '')}${members.length?` · ${escapeHtml(members.map(person=>person.display_name).join(', '))}`:''}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-family-link">Ta bort</button></div>`}).join('')}
        ${links.length || familyLinks.length ? '' : '<p>Ingen person eller familjegren är kopplad ännu.</p>'}
      </div>
      <label class="full-field">Lägg till koppling<select id="relation-link-select"><option value="">Välj person eller familjegren …</option><optgroup label="Personer">${matrikelPeople.map(person=>`<option value="person:${escapeHtml(person.id)}">${escapeHtml(person.display_name)}${person.club_name ? ` · ${escapeHtml(person.club_name)}` : ''}</option>`).join('')}</optgroup><optgroup label="Familjegrenar">${families.map(family=>`<option value="family:${escapeHtml(family.id)}">${escapeHtml(family.name)}</option>`).join('')}</optgroup></select></label>
      <label class="full-field">Roll<input id="relation-link-role" value="ägare/anknuten"></label>
      <div class="button-row"><button class="secondary" type="button" data-action="add-link">Lägg till koppling</button><button class="secondary" type="button" data-action="refresh-people">Hämta personer från Matrikeln</button></div>
    </section>
    <section class="drawer-section"><h3>Bilder</h3><p>${(boat.images||[]).length} bildposter. Nya bilder lagras privat i Dropbox.</p><input id="image-upload" type="file" accept="image/*"><div class="button-row"><button class="danger" type="button" data-action="delete-boat">Ta bort båten</button></div></section>`;
  drawer.setAttribute('aria-hidden','false'); backdrop.hidden=false;
  hydrateImages(drawer);
}

function openDrawer(id) { selectedBoatId=id; renderDrawer(id); }
function closeDrawer() { selectedBoatId=null; drawer.setAttribute('aria-hidden','true'); backdrop.hidden=true; drawerContent.innerHTML=''; }

function parseField(target) {
  const field = target.dataset.boatField;
  if (['ar','dopar'].includes(field)) return target.value ? Number(target.value) : null;
  if (field === 'langd_m') return target.value ? Number(target.value.replace(',','.')) : null;
  if (['tidigare_namn','senare_namn','smeknamn'].includes(field)) return target.value.split(',').map(value=>value.trim()).filter(Boolean);
  return target.value.trim() || null;
}

async function syncEdit(action) {
  await action(); render();
  try { await syncNow(); } catch (_) { setStatus('Sparat lokalt · synk kräver åtgärd','warning'); }
}

async function addBoat() {
  const name = prompt('Båtens namn (kan ändras senare):');
  if (!name?.trim()) return;
  const id = `${slug(name)}-${crypto.randomUUID().slice(0,8)}`;
  await syncEdit(()=>repository.setFields([
    {entityType:'boat',entityId:id,field:'namn',value:name.trim()},
    {entityType:'boat',entityId:id,field:'namnstatus',value:'namn'},
    {entityType:'boat',entityId:id,field:'images',value:[]},
    {entityType:'boat',entityId:id,field:'kallor',value:['direkt i Båtregister']},
  ]));
  openDrawer(id);
}

async function deleteBoat() {
  const boat = boatRecords().find(item=>item.id===selectedBoatId); if(!boat)return;
  const links=linksForBoat(boat.id);
  const familyLinks=familyLinksForBoat(boat.id);
  if(!confirm(`Ta bort ${boat.namn} och ${links.length+familyLinks.length} kopplingar? Historiken finns kvar som tombstones.`))return;
  await syncEdit(()=>repository.deleteEntities([...links.map(link=>({entityType:'boat-person-link',entityId:link.id})),...familyLinks.map(link=>({entityType:'boat-family-link',entityId:link.id})),{entityType:'boat',entityId:boat.id}]));
  closeDrawer();
}

async function addRelationLink() {
  const value=$('#relation-link-select')?.value; if(!value)return;
  const [kind,id]=value.split(':'); const role=$('#relation-link-role').value.trim()||'ägare/anknuten';
  if(kind==='person'){
    const person=matrikelPeople.find(item=>item.id===id); if(!person)return;
    const linkId=`${selectedBoatId}--${person.id}`;
    await syncEdit(()=>repository.setFields([
      {entityType:'boat-person-link',entityId:linkId,field:'boat_id',value:selectedBoatId},
      {entityType:'boat-person-link',entityId:linkId,field:'person_id',value:person.id},
      {entityType:'boat-person-link',entityId:linkId,field:'person_display_name',value:person.display_name},
      {entityType:'boat-person-link',entityId:linkId,field:'role',value:role},
      {entityType:'boat-person-link',entityId:linkId,field:'confidence',value:'godkänd i appen'},
    ]));
    return;
  }
  if(kind==='family'){
    const family=familyRecords().find(item=>item.id===id); if(!family)return;
    const linkId=`${selectedBoatId}--family--${family.id}`;
    await syncEdit(()=>repository.setFields([
      {entityType:'boat-family-link',entityId:linkId,field:'boat_id',value:selectedBoatId},
      {entityType:'boat-family-link',entityId:linkId,field:'family_id',value:family.id},
      {entityType:'boat-family-link',entityId:linkId,field:'family_name',value:family.name},
      {entityType:'boat-family-link',entityId:linkId,field:'role',value:role},
      {entityType:'boat-family-link',entityId:linkId,field:'confidence',value:'godkänd i appen'},
    ]));
  }
}

async function deleteLink(type,id) { await syncEdit(()=>repository.deleteEntity(type,id)); }

async function uploadImage(file) {
  if (!file || !selectedBoatId) return;
  const hashBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  const hash=[...hashBytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const extension=(file.type.split('/')[1]||'bin').replace('jpeg','jpg');
  const path=`/batregister/bilder/${hash}.${extension}`;
  await store.putBlob(path,file,{pendingUpload:true});
  objectUrl(path,file);
  const boat=boatRecords().find(item=>item.id===selectedBoatId);
  const images=[...(boat.images||[]),{id:crypto.randomUUID(),thumb:{dropbox_path:path,sha256:hash},full:{dropbox_path:path,sha256:hash},source:`Uppladdad ${new Date().toISOString()}`}];
  await syncEdit(()=>repository.setField('boat',boat.id,'images',images));
}

async function completeOAuthCallbackIfNeeded() {
  const url=new URL(location.href); if(!url.searchParams.has('code')&&!url.searchParams.has('error'))return;
  const token=await completeDropboxOAuth(); accessToken=token.access_token;
  accessTokenExpiresAt=Date.now()+Math.max(30,Number(token.expires_in||0)-60)*1000;
  if(token.refresh_token)await store.putMeta(TOKEN_META,token.refresh_token);
  for(const parameter of ['code','state','error','error_description'])url.searchParams.delete(parameter);
  history.replaceState({},'',`${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if(accessToken&&Date.now()<accessTokenExpiresAt)return accessToken;
  const refreshToken=await store.getMeta(TOKEN_META); if(!refreshToken||!DROPBOX_CLIENT_ID)return null;
  if(navigator.onLine===false)return null;
  const token=await exchangeDropboxRefreshToken({clientId:DROPBOX_CLIENT_ID,refreshToken});
  accessToken=token.access_token; accessTokenExpiresAt=Date.now()+Math.max(30,Number(token.expires_in||0)-60)*1000;if(token.refresh_token&&token.refresh_token!==refreshToken)await store.putMeta(TOKEN_META,token.refresh_token);return accessToken;
}

async function uploadBootstrapOps(transport) {
  const pending=await store.getMeta(BOOTSTRAP_META); if(!pending?.pending)return 0;
  const operations=(await store.getAllOps()).filter(op=>op.device_id===pending.device_id).sort((a,b)=>a.seq-b.seq);
  let uploaded=0; for(let index=0;index<operations.length;index+=250){const batch=createBatch(operations.slice(index,index+250));await transport.putBatch(batch);uploaded+=batch.ops.length;setStatus(`Laddar upp startmaster · ${uploaded}/${operations.length}`)}
  await store.putMeta(BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
}

async function uploadBootstrapImages(transport) {
  const pending=await store.getMeta(IMAGE_BOOTSTRAP_META); if(!pending?.pending||!isSourceTree)return 0;
  const response=await fetch(LOCAL_IMAGE_MANIFEST_URL,{cache:'no-store'}); if(!response.ok)throw new Error('Bildmanifestet kunde inte läsas');
  const manifest=await response.json(); let uploaded=0;
  for(const file of manifest.image_files){const imageResponse=await fetch(`${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(file.filename)}`,{cache:'no-store'});if(!imageResponse.ok)throw new Error(`Startbild saknas: ${file.filename}`);const blob=await imageResponse.blob();await transport.putBlobImmutable(file.dropbox_path,blob);await store.putBlob(file.dropbox_path,blob);uploaded+=1;if(uploaded%10===0)setStatus(`Laddar upp startbilder · ${uploaded}/${manifest.image_files.length}`)}
  await store.putMeta(IMAGE_BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
}

async function loadMatrikelPeople(token) {
  if(!token)return [];
  const repo=await new Repository({store:new MemoryStore(),deviceId:'bat-matrikel-read'}).init();
  const transport=new DropboxTransport({accessToken:token,id:'dropbox-matrikel-read',opsRoot:'/ops'});
  await new SyncEngine({repository:repo,transport}).downloadRemote();
  matrikelPeople=repo.listEntities('person').map(entity=>({id:entity.entity_id,...entity.fields})).sort((a,b)=>a.display_name.localeCompare(b.display_name,'sv'));
  await store.putMeta(MATRIKEL_PEOPLE_META,matrikelPeople);
  if(selectedBoatId)renderDrawer(selectedBoatId); return matrikelPeople;
}

async function syncNow() {
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{const hasCredential=Boolean(await store.getMeta(TOKEN_META));if(navigator.onLine===false){setStatus(`Offline · ${hasCredential?'Dropbox ansluten · ':''}ändringar sparas lokalt`,'warning');connectButton.textContent=hasCredential?'Offline · Dropbox ansluten':'Anslut Dropbox när du är online';return null}const token=await currentAccessToken();if(!token){setStatus('Lokalt sparat · Dropbox ej ansluten','warning');connectButton.textContent='Anslut Dropbox';return null}
    connectButton.textContent='Synka Dropbox';setStatus('Synkar…');const transport=new DropboxTransport({accessToken:token,id:'dropbox-batregister',opsRoot:'/batregister/ops'});
    const images=await uploadBootstrapImages(transport);const bootstrap=await uploadBootstrapOps(transport);const queuedImages=await uploadPendingImages(transport);const result=await new SyncEngine({repository,transport}).syncOnce();
    const cached=await cacheAllBoatImages(transport);render();
    if(!matrikelPeople.length)await loadMatrikelPeople(token).catch(error=>console.warn('Matrikelpersoner kunde inte hämtas',error));
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    setStatus(`Synkad · ${bootstrap+result.uploadedOps} upp, ${result.downloadedOps} ned · ${cached.total} bilder offline${images+queuedImages?` · ${images+queuedImages} bilder upp`:''}`,'ok');return result})().catch(error=>{console.error(error);if(isOfflineError(error)){setStatus('Offline · lokalt sparat · synkas automatiskt när nätet återkommer','warning');return null}setStatus(`Åtgärd krävs · ${error.message}`,'error');throw error}).finally(()=>{syncPromise=null});
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return',new URL('batregister/',redirectUri()).pathname);
  const attempt=await beginDropboxOAuth({clientId:DROPBOX_CLIENT_ID,redirectUri:redirectUri(),scopes:DROPBOX_SCOPES});location.assign(attempt.url);
}
async function connectOrSyncDropbox(){return await currentAccessToken()?syncNow():connectDropbox()}

async function bootstrapLocal() {
  if(!isSourceTree)throw new Error('Startkopian kan bara aktiveras från källappen');
  const response=await fetch(LOCAL_BOOTSTRAP_URL,{cache:'no-store'});if(!response.ok)throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document=await response.json();if(document.operations_version!==1||!Array.isArray(document.operations))throw new Error('Startkopian har fel format');document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META,{pending:true,device_id:document.device_id,migration_id:document.migration_id,operations:document.operations.length});
  await store.putMeta(IMAGE_BOOTSTRAP_META,{pending:true,migration_id:document.migration_id});bootstrapButton.hidden=true;render();setStatus('Startmaster aktiverad lokalt · anslut Dropbox för uppladdning','ok');
}

content.addEventListener('click',event=>{const target=event.target.closest('[data-boat-id]');if(target)openDrawer(target.dataset.boatId)});
backdrop.addEventListener('click',closeDrawer);
drawer.addEventListener('click',event=>{if(event.target.closest('[data-action="close"]'))closeDrawer();const remove=event.target.closest('[data-delete-link]');if(remove)deleteLink(remove.dataset.linkType,remove.dataset.deleteLink);if(event.target.closest('[data-action="add-link"]'))addRelationLink();if(event.target.closest('[data-action="delete-boat"]'))deleteBoat();if(event.target.closest('[data-action="refresh-people"]'))currentAccessToken().then(loadMatrikelPeople)});
drawer.addEventListener('change',event=>{const field=event.target.closest('[data-boat-field]');if(field)syncEdit(()=>repository.setField('boat',selectedBoatId,field.dataset.boatField,parseField(field)));if(event.target.id==='image-upload')uploadImage(event.target.files?.[0]).catch(error=>setStatus(`Bilden kunde inte sparas · ${error.message}`,'error'))});
$('#search').addEventListener('input',event=>{ui.search=event.target.value;render()});
$('#type-filter').addEventListener('change',event=>{ui.type=event.target.value;render()});
$('#person-filter').addEventListener('change',event=>{ui.person=event.target.value;render()});
$('#family-filter').addEventListener('change',event=>{ui.family=event.target.value;render()});
$('#name-filter').addEventListener('change',event=>{ui.nameStatus=event.target.value;render()});
$('#grouping').addEventListener('change',event=>{ui.grouping=event.target.value;render()});
$('#image-only').addEventListener('change',event=>{ui.imageOnly=event.target.checked;render()});
$('#add-boat').addEventListener('click',addBoat);connectButton.addEventListener('click',()=>connectOrSyncDropbox().catch(()=>{}));bootstrapButton.addEventListener('click',()=>bootstrapLocal().catch(error=>setStatus(error.message,'error')));
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDrawer()});window.addEventListener('online',()=>syncNow().catch(()=>{}));window.addEventListener('offline',()=>syncNow().catch(()=>{}));document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow().catch(()=>{})});

async function init(){const serviceWorkerPromise=registerServiceWorker();const db=await openSlaktlandskapDB({name:'korpholmen-batregister'});store=new IndexedDBStore(db);repository=await new Repository({store,deviceId:deviceId()}).init();matrikelPeople=await store.getMeta(MATRIKEL_PEOPLE_META)||[];bootstrapButton.hidden=!isSourceTree||boatRecords().length>0;render();await completeOAuthCallbackIfNeeded();await syncNow();await serviceWorkerPromise}
init().catch(error=>{console.error(error);setStatus(`Kunde inte starta · ${error.message}`,'error')});
