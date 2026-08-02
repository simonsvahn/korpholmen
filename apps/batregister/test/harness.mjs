import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore, materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-01');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const imageManifest=await readJson(resolve(PRIVATE,'bildmanifest.json'));
const decisions=await readJson(resolve(ROOT,'privat/kallkopior/byggkit/godkanda-kopplingar-2026-08-01.json'));
const state=materialize(document.operations);

await test('startmastern innehåller 168 båtar och giltiga operationer',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(state.listEntities('boat').length,168);
  assert.equal(state.listEntities('boat-person-link').length,173);
  assert.ok(state.listEntities('family').length>4);
  assert.equal(state.listEntities('boat-family-link').length,8);
  for(const family of decisions.families)assert.ok(state.listEntities('family').some(entity=>entity.entity_id===family.id),family.id);
});

await test('alla säkra båt-person-länkar pekar på en person i Matrikeln',async()=>{
  const path=resolve(ROOT,'../matrikel/privat/migrering-2026-08-01');
  const docs=await Promise.all(['initial-ops.json','ui-metadata-ops.json','approved-excel-ops.json'].map(file=>readJson(resolve(path,file))));
  const matrikel=materialize(docs.flatMap(item=>item.operations));
  const people=new Set(matrikel.listEntities('person').map(person=>person.entity_id));
  for(const link of state.listEntities('boat-person-link'))assert.ok(people.has(link.fields.person_id),link.fields.person_id);
  for(const family of state.listEntities('family'))for(const personId of family.fields.explicit_person_ids||[])assert.ok(people.has(personId),personId);
});

await test('godkända och avvisade kopplingar hålls isär',()=>{
  const links=new Set(state.listEntities('boat-person-link').map(link=>`${link.fields.boat_id}--${link.fields.person_id}`));
  for(const link of decisions.approved_person_links)assert.ok(links.has(`${link.boat_id}--${link.person_id}`),`Godkänd länk saknas: ${link.boat_id} → ${link.person_id}`);
  for(const link of decisions.rejected_person_suggestions)assert.ok(!links.has(`${link.boat_id}--${link.person_id}`),`Avvisad länk återkom: ${link.boat_id} → ${link.person_id}`);
  assert.ok(links.has('gerry--lisaböving'));
  assert.ok(!links.has('gerry--lisalifilipåkerman'));
  assert.ok(links.has('eos--nissehedströmyngre'));
  assert.ok(links.has('goggelmoggel--nissehedströmyngre'));
  assert.ok(!links.has('eos--nilshenrikhedström'));
  assert.ok(!links.has('goggelmoggel--nilshenrikhedström'));
  const lillaManasse=state.listEntities('boat').find(boat=>boat.entity_id==='lillamanasse');
  assert.equal(lillaManasse.fields.island_connection,'före ön');
});

await test('bildmanifestet är komplett och kryptografiskt låst',async()=>{
  assert.equal(imageManifest.counts.image_records,100);
  assert.equal(imageManifest.image_files.length,193);
  for(const file of imageManifest.image_files){const bytes=await readFile(resolve(PRIVATE,'bilder',file.filename));assert.equal(bytes.length,file.bytes);assert.equal(sha256(bytes),file.sha256)}
});

await test('Dropbox-namnrymden skiljer Båtregister från Matrikeln',async()=>{
  const transport=await readFile(resolve(REPO,'packages/core/sync/dropbox-transport.js'),'utf8');
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(transport.includes("opsRoot = '/ops'"));
  assert.ok(app.includes("opsRoot: '/batregister/ops'"));
  assert.ok(app.includes("opsRoot:'/matrikel/ops'"));
});

await test('webbgränssnittet kan ändra båtar, länkar och bilder',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const html=await readFile(resolve(ROOT,'index.html'),'utf8');
  assert.ok(app.includes("repository.setField('boat'"));
  assert.ok(app.includes("entityType:'boat-person-link'"));
  assert.ok(app.includes("entityType:'boat-family-link'"));
  assert.ok(app.includes("entityType:'boat-group-link'"));
  assert.ok(app.includes('person:${escapeHtml(person.id)}'));
  assert.ok(app.includes('legacy-family:${escapeHtml(family.id)}'));
  assert.ok(app.includes('FAMILY_UNIT_TYPE'));
  assert.ok(app.includes('KIN_GROUP_TYPE'));
  assert.ok(app.includes("link.person_id === ui.person"));
  assert.ok(app.includes('../matrikel/?person='));
  assert.ok(html.includes('id="person-filter"'));
  assert.ok(html.includes('Familj eller släkt'));
  assert.ok(html.includes('stabil FAMILJ'));
  assert.ok(html.includes('stabil SLÄKT'));
  assert.ok(app.includes('putBlobImmutable'));
  assert.ok(app.includes("repository.deleteEntities"));
});

await test('båtar kan länkas till stabil FAMILJ eller SLÄKT med ärvd synlighet',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const core=await readFile(resolve(REPO,'packages/core/family-context.js'),'utf8');
  assert.ok(app.includes('associationAppliesToTarget'));
  assert.ok(app.includes('targetMemberDetails'));
  assert.ok(app.includes("field:'target_code'"));
  assert.ok(app.includes("field:'confirmed',value:true"));
  assert.ok(core.includes('anchors_and_descendants'));
  assert.ok(core.includes("return 'FAMILJ'"));
  assert.ok(core.includes("return 'SLÄKT'"));
});

await test('båtbilder kan köas och läsas lokalt utan Dropbox',async()=>{
  const store=new MemoryStore();
  const blob=new Blob(['offline-bild'],{type:'image/jpeg'});
  await store.putBlob('/batregister/bilder/offline.jpg',blob,{pendingUpload:true});
  assert.equal(await (await store.getBlob('/batregister/bilder/offline.jpg')).text(),'offline-bild');
  assert.equal((await store.listPendingBlobs()).length,1);
  await store.markBlobUploaded('/batregister/bilder/offline.jpg');
  assert.equal((await store.listPendingBlobs()).length,0);
});

await test('webbappen lagrar hela bildbeståndet och nya bilder för offlinebruk',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const storage=await readFile(resolve(REPO,'packages/core/storage/indexeddb.js'),'utf8');
  assert.ok(storage.includes("createObjectStore('blobs'"));
  assert.ok(app.includes('cacheAllBoatImages'));
  assert.ok(app.includes('uploadPendingImages'));
  assert.ok(app.includes("store.putBlob(path,file,{pendingUpload:true})"));
  assert.ok(app.includes("Offline · lokalt sparat · synkas automatiskt"));
});

await test('publiceringsbygget är datafritt',()=>{
  const result=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

await test('publiceringspaketet har en egen offlinebar kopia av kärnan',async()=>{
  const publishedApp=await readFile(resolve(REPO,'batregister/src/app.js'),'utf8');
  const publishedCore=await readFile(resolve(REPO,'batregister/core/data-layer.js'),'utf8');
  const serviceWorker=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedCore.includes("./storage/indexeddb.js"));
  assert.ok(serviceWorker.includes("?'../../packages/core':'./core'"));
  assert.ok(serviceWorker.includes("'./src/config.js'"));
});

await test('OAuth-returen kan skickas till båda apparna',async()=>{
  const root=await readFile(resolve(REPO,'index.html'),'utf8');
  const matrikel=await readFile(resolve(REPO,'apps/matrikel/src/app.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(root.includes('korpholmen:oauth-return'));
  assert.ok(root.includes('matrikel/'));
  assert.ok(root.includes('batregister/'));
  assert.ok(matrikel.includes("isSourceTree ? '../../' : '../'"));
  assert.ok(boats.includes("isSourceTree ? '../../' : '../'"));
});

await test('service workers rensar bara sina egna cacher',async()=>{
  const matrikel=await readFile(resolve(REPO,'apps/matrikel/sw.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(matrikel.includes("key.startsWith('korpholmen-matrikel-')"));
  assert.ok(boats.includes("key.startsWith('korpholmen-batregister-')"));
  assert.ok(matrikel.includes("return cached || network"));
  assert.ok(boats.includes("return cached||network"));
});

console.log(`\n${passed} Båtregister-kontrakt godkända.`);
