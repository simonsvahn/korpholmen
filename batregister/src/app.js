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
} from '../../packages/core/data-layer.js';
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
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:batregister-2026-08-01';
const IMAGE_BOOTSTRAP_META = 'bootstrap:batregister-images-2026-08-01';
const imageUrls = new Map();

let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedBoatId = null;
let matrikelPeople = [];

const ui = { search: '', type: '', family: '', nameStatus: '', imageOnly: false, grouping: 'none' };
const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const unique = values => [...new Set(values.filter(Boolean))];
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const slug = value => normalize(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'bat';

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
  const fromSourceTree = location.pathname.includes('/apps/batregister/');
  return new URL(fromSourceTree ? '../../' : '../', location.href).href;
}
function boatRecords() { return repository.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>String(a.namn).localeCompare(String(b.namn),'sv')); }
function linkRecords() { return repository.listEntities('boat-person-link').map(entity => ({ id: entity.entity_id, ...entity.fields })); }
function linksForBoat(id) { return linkRecords().filter(link => link.boat_id === id); }

function optionList(select, values, label) {
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(label)}</option>${values.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  select.value = values.includes(current) ? current : '';
}

function filteredBoats() {
  const query = normalize(ui.search);
  return boatRecords().filter(boat => {
    if (ui.type && boat.typ !== ui.type) return false;
    if (ui.family && boat.slakt !== ui.family) return false;
    if (ui.nameStatus && boat.namnstatus !== ui.nameStatus) return false;
    if (ui.imageOnly && !(boat.images || []).length) return false;
    if (query && !normalize([boat.namn, boat.dopnamn, boat.modell, boat.agare, boat.motor, boat.slakt, ...(boat.kallor_text || [])].join(' ')).includes(query)) return false;
    return true;
  });
}

function era(boat) {
  const year = Number(boat.ar || boat.dopar);
  if (!year) return 'År okänt';
  return `${Math.floor(year / 10) * 10}-talet`;
}

function groupBoats(boats) {
  const key = ui.grouping === 'family' ? boat => boat.slakt || 'Övriga och okända'
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
  const local = isLocal && ref.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(ref.filename)}` : '';
  const cached = imageUrls.get(ref.dropbox_path);
  const source = local || cached || '';
  return `<img class="boat-image" alt="${escapeHtml(boat.namn || 'Båt')}" ${source ? `src="${escapeHtml(source)}"` : ''} data-image-path="${escapeHtml(ref.dropbox_path || '')}" style="${boat.images?.[0]?.focus ? `object-position:${escapeHtml(boat.images[0].focus)}` : ''}">`;
}

function card(boat) {
  const links = linksForBoat(boat.id);
  return `<button class="boat-card" type="button" data-boat-id="${escapeHtml(boat.id)}">
    ${imageMarkup(boat)}${links.length ? `<span class="linked-count">${links.length} person${links.length === 1 ? '' : 'er'}</span>` : ''}
    <span class="boat-copy"><h3>${escapeHtml(boat.namn || 'Namn okänt')}</h3>
      <p>${escapeHtml([boat.modell, boat.ar].filter(Boolean).join(' · ') || 'Modell och år saknas')}</p>
      <p>${escapeHtml(boat.agare || 'Ägare/anknytning saknas')}</p>
      <span class="chips">${boat.typ ? `<span class="chip">${escapeHtml(boat.typ)}</span>` : ''}${boat.slakt ? `<span class="chip">${escapeHtml(boat.slakt)}</span>` : ''}${boat.namnstatus === 'dopnamn' ? '<span class="chip warn">Endast dopnamn</span>' : ''}</span>
    </span></button>`;
}

async function hydrateImages(scope = document) {
  if (!accessToken || isLocal) return;
  const nodes = [...scope.querySelectorAll('img[data-image-path]')].filter(node => node.dataset.imagePath && !node.src);
  const transport = new DropboxTransport({ accessToken, id: 'dropbox-batregister-images', opsRoot: '/batregister/ops' });
  await Promise.all(nodes.map(async node => {
    const path = node.dataset.imagePath;
    try {
      let url = imageUrls.get(path);
      if (!url) { url = URL.createObjectURL(await transport.getBlob(path)); imageUrls.set(path, url); }
      node.src = url;
    } catch (error) { node.alt = `Bild kunde inte hämtas: ${error.message}`; }
  }));
}

function render() {
  const all = boatRecords();
  optionList($('#type-filter'), unique(all.map(boat=>boat.typ)).sort((a,b)=>a.localeCompare(b,'sv')), 'Alla typer');
  optionList($('#family-filter'), unique(all.map(boat=>boat.slakt)).sort((a,b)=>a.localeCompare(b,'sv')), 'Alla släkter');
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
  const fullRef = imageRef(boat, 'full');
  const local = isLocal && fullRef?.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(fullRef.filename)}` : '';
  const cached = fullRef?.dropbox_path ? imageUrls.get(fullRef.dropbox_path) : '';
  const image = fullRef ? `<img class="drawer-image" alt="${escapeHtml(boat.namn)}" ${local || cached ? `src="${escapeHtml(local || cached)}"` : ''} data-image-path="${escapeHtml(fullRef.dropbox_path || '')}">` : '';
  drawerContent.innerHTML = `<h2 class="drawer-title">${escapeHtml(boat.namn || 'Namn okänt')}</h2>${image}
    <div class="edit-grid">
      ${textField('Namn','namn',boat.namn)}
      <label>Namnstatus<select data-boat-field="namnstatus"><option value="namn" ${boat.namnstatus==='namn'?'selected':''}>Känt namn</option><option value="dopnamn" ${boat.namnstatus==='dopnamn'?'selected':''}>Endast dopnamn</option></select></label>
      ${textField('Dopnamn','dopnamn',boat.dopnamn)}${textField('Önskat namn','onskat_namn',boat.onskat_namn)}
      ${textField('Typ','typ',boat.typ)}${textField('Modell','modell',boat.modell)}
      ${numberField('År','ar',boat.ar)}${numberField('Längd (m)','langd_m',boat.langd_m,'0.1')}
      ${textField('Motor','motor',boat.motor)}${textField('Släkt/grupp','slakt',boat.slakt)}
      ${textField('Period','period',boat.period,'span-2')}${textField('Ägare/anknytning','agare',boat.agare,'span-2')}
      ${textField('Tidigare namn, kommaseparerade','tidigare_namn',(boat.tidigare_namn||[]).join(', '),'span-2')}
      ${textField('Senare namn, kommaseparerade','senare_namn',(boat.senare_namn||[]).join(', '),'span-2')}
    </div>
    <section class="drawer-section"><h3>Personkopplingar</h3>
      <div class="link-list">${links.map(link=>`<div class="link-row"><span><b>${escapeHtml(link.person_display_name || link.person_id)}</b><br><small>${escapeHtml(link.role || '')}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}">Ta bort</button></div>`).join('') || '<p>Ingen person är kopplad ännu.</p>'}</div>
      <label class="full-field">Lägg till person<select id="person-link-select"><option value="">Välj person ur Matrikeln …</option>${matrikelPeople.map(person=>`<option value="${escapeHtml(person.id)}">${escapeHtml(person.display_name)}${person.club_name ? ` · ${escapeHtml(person.club_name)}` : ''}</option>`).join('')}</select></label>
      <label class="full-field">Roll<input id="person-link-role" value="ägare/anknuten"></label>
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
  if(!confirm(`Ta bort ${boat.namn} och ${links.length} personkopplingar? Historiken finns kvar som tombstones.`))return;
  await syncEdit(()=>repository.deleteEntities([...links.map(link=>({entityType:'boat-person-link',entityId:link.id})),{entityType:'boat',entityId:boat.id}]));
  closeDrawer();
}

async function addPersonLink() {
  const personId=$('#person-link-select')?.value; if(!personId)return;
  const person=matrikelPeople.find(item=>item.id===personId); if(!person)return;
  const id=`${selectedBoatId}--${person.id}`;
  await syncEdit(()=>repository.setFields([
    {entityType:'boat-person-link',entityId:id,field:'boat_id',value:selectedBoatId},
    {entityType:'boat-person-link',entityId:id,field:'person_id',value:person.id},
    {entityType:'boat-person-link',entityId:id,field:'person_display_name',value:person.display_name},
    {entityType:'boat-person-link',entityId:id,field:'role',value:$('#person-link-role').value.trim()||'ägare/anknuten'},
    {entityType:'boat-person-link',entityId:id,field:'confidence',value:'godkänd i appen'},
  ]));
}

async function deleteLink(id) { await syncEdit(()=>repository.deleteEntity('boat-person-link',id)); }

async function uploadImage(file) {
  if (!file || !selectedBoatId) return;
  const token=await currentAccessToken();
  if(!token){alert('Anslut Dropbox innan du lägger till en bild.');return;}
  const hashBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  const hash=[...hashBytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const extension=(file.type.split('/')[1]||'bin').replace('jpeg','jpg');
  const path=`/batregister/bilder/${hash}.${extension}`;
  const transport=new DropboxTransport({accessToken:token,id:'dropbox-batregister-images',opsRoot:'/batregister/ops'});
  setStatus('Laddar upp bild…'); await transport.putBlobImmutable(path,file);
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
  const token=await exchangeDropboxRefreshToken({clientId:DROPBOX_CLIENT_ID,refreshToken});
  accessToken=token.access_token; accessTokenExpiresAt=Date.now()+Math.max(30,Number(token.expires_in||0)-60)*1000; return accessToken;
}

async function uploadBootstrapOps(transport) {
  const pending=await store.getMeta(BOOTSTRAP_META); if(!pending?.pending)return 0;
  const operations=(await store.getAllOps()).filter(op=>op.device_id===pending.device_id).sort((a,b)=>a.seq-b.seq);
  let uploaded=0; for(let index=0;index<operations.length;index+=250){const batch=createBatch(operations.slice(index,index+250));await transport.putBatch(batch);uploaded+=batch.ops.length;setStatus(`Laddar upp startmaster · ${uploaded}/${operations.length}`)}
  await store.putMeta(BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
}

async function uploadBootstrapImages(transport) {
  const pending=await store.getMeta(IMAGE_BOOTSTRAP_META); if(!pending?.pending||!isLocal)return 0;
  const response=await fetch(LOCAL_IMAGE_MANIFEST_URL,{cache:'no-store'}); if(!response.ok)throw new Error('Bildmanifestet kunde inte läsas');
  const manifest=await response.json(); let uploaded=0;
  for(const file of manifest.image_files){const imageResponse=await fetch(`${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(file.filename)}`,{cache:'no-store'});if(!imageResponse.ok)throw new Error(`Startbild saknas: ${file.filename}`);await transport.putBlobImmutable(file.dropbox_path,await imageResponse.blob());uploaded+=1;if(uploaded%10===0)setStatus(`Laddar upp startbilder · ${uploaded}/${manifest.image_files.length}`)}
  await store.putMeta(IMAGE_BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
}

async function loadMatrikelPeople(token) {
  if(!token)return [];
  const repo=await new Repository({store:new MemoryStore(),deviceId:'bat-matrikel-read'}).init();
  const transport=new DropboxTransport({accessToken:token,id:'dropbox-matrikel-read',opsRoot:'/ops'});
  await new SyncEngine({repository:repo,transport}).downloadRemote();
  matrikelPeople=repo.listEntities('person').map(entity=>({id:entity.entity_id,...entity.fields})).sort((a,b)=>a.display_name.localeCompare(b.display_name,'sv'));
  if(selectedBoatId)renderDrawer(selectedBoatId); return matrikelPeople;
}

async function syncNow() {
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{const token=await currentAccessToken();if(!token){setStatus('Lokalt sparat · Dropbox ej ansluten','warning');connectButton.textContent='Anslut Dropbox';return null}
    connectButton.textContent='Synka Dropbox';setStatus('Synkar…');const transport=new DropboxTransport({accessToken:token,id:'dropbox-batregister',opsRoot:'/batregister/ops'});
    const images=await uploadBootstrapImages(transport);const bootstrap=await uploadBootstrapOps(transport);const result=await new SyncEngine({repository,transport}).syncOnce();
    render();setStatus(`Synkad · ${bootstrap+result.uploadedOps} upp, ${result.downloadedOps} ned${images?` · ${images} bilder`:''}`,'ok');
    if(!matrikelPeople.length)loadMatrikelPeople(token).catch(error=>console.warn('Matrikelpersoner kunde inte hämtas',error));return result})().catch(error=>{console.error(error);setStatus(`Åtgärd krävs · ${error.message}`,'error');throw error}).finally(()=>{syncPromise=null});
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return',new URL('batregister/',redirectUri()).pathname);
  const attempt=await beginDropboxOAuth({clientId:DROPBOX_CLIENT_ID,redirectUri:redirectUri(),scopes:DROPBOX_SCOPES});location.assign(attempt.url);
}
async function connectOrSyncDropbox(){return await currentAccessToken()?syncNow():connectDropbox()}

async function bootstrapLocal() {
  if(!isLocal)throw new Error('Startkopian kan bara aktiveras lokalt');
  const response=await fetch(LOCAL_BOOTSTRAP_URL,{cache:'no-store'});if(!response.ok)throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document=await response.json();if(document.operations_version!==1||!Array.isArray(document.operations))throw new Error('Startkopian har fel format');document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META,{pending:true,device_id:document.device_id,migration_id:document.migration_id,operations:document.operations.length});
  await store.putMeta(IMAGE_BOOTSTRAP_META,{pending:true,migration_id:document.migration_id});bootstrapButton.hidden=true;render();setStatus('Startmaster aktiverad lokalt · anslut Dropbox för uppladdning','ok');
}

content.addEventListener('click',event=>{const target=event.target.closest('[data-boat-id]');if(target)openDrawer(target.dataset.boatId)});
backdrop.addEventListener('click',closeDrawer);
drawer.addEventListener('click',event=>{if(event.target.closest('[data-action="close"]'))closeDrawer();const remove=event.target.closest('[data-delete-link]');if(remove)deleteLink(remove.dataset.deleteLink);if(event.target.closest('[data-action="add-link"]'))addPersonLink();if(event.target.closest('[data-action="delete-boat"]'))deleteBoat();if(event.target.closest('[data-action="refresh-people"]'))currentAccessToken().then(loadMatrikelPeople)});
drawer.addEventListener('change',event=>{const field=event.target.closest('[data-boat-field]');if(field)syncEdit(()=>repository.setField('boat',selectedBoatId,field.dataset.boatField,parseField(field)));if(event.target.id==='image-upload')uploadImage(event.target.files?.[0])});
$('#search').addEventListener('input',event=>{ui.search=event.target.value;render()});
$('#type-filter').addEventListener('change',event=>{ui.type=event.target.value;render()});
$('#family-filter').addEventListener('change',event=>{ui.family=event.target.value;render()});
$('#name-filter').addEventListener('change',event=>{ui.nameStatus=event.target.value;render()});
$('#grouping').addEventListener('change',event=>{ui.grouping=event.target.value;render()});
$('#image-only').addEventListener('change',event=>{ui.imageOnly=event.target.checked;render()});
$('#add-boat').addEventListener('click',addBoat);connectButton.addEventListener('click',()=>connectOrSyncDropbox().catch(()=>{}));bootstrapButton.addEventListener('click',()=>bootstrapLocal().catch(error=>setStatus(error.message,'error')));
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDrawer()});window.addEventListener('online',()=>syncNow().catch(()=>{}));

async function init(){const db=await openSlaktlandskapDB({name:'korpholmen-batregister'});store=new IndexedDBStore(db);repository=await new Repository({store,deviceId:deviceId()}).init();bootstrapButton.hidden=!isLocal||boatRecords().length>0;render();await completeOAuthCallbackIfNeeded();await syncNow();if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(console.error)}
init().catch(error=>{console.error(error);setStatus(`Kunde inte starta · ${error.message}`,'error')});
