import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore, materialize, validateOperation } from '../../../packages/core/data-layer.js';
import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_TYPE,
  buildFamilyContext,
  familyBrowseHierarchy,
  familySelectionMatches,
  searchFamilyTargets,
  targetMemberDetails,
} from '../../../packages/core/family-context.js';
import {
  boatMatchesConnection,
  personScopeTargets,
  searchPeopleForConnection,
} from '../src/connection-filter.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-01');
const CORRECTIONS=resolve(ROOT,'privat/korrigeringar');
const PETER_CORRECTION=resolve(CORRECTIONS,'2026-08-03-peter-identitetsdelning.json');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const imageManifest=await readJson(resolve(PRIVATE,'bildmanifest.json'));
const decisions=await readJson(resolve(ROOT,'privat/kallkopior/byggkit/godkanda-kopplingar-2026-08-01.json'));
const firstPeterBuild=spawnSync(process.execPath,['verktyg/bygg-peter-identitetsdelning.mjs'],{cwd:ROOT,encoding:'utf8'});
assert.equal(firstPeterBuild.status,0,firstPeterBuild.stderr||firstPeterBuild.stdout);
const firstPeterBytes=await readFile(PETER_CORRECTION);
const secondPeterBuild=spawnSync(process.execPath,['verktyg/bygg-peter-identitetsdelning.mjs'],{cwd:ROOT,encoding:'utf8'});
assert.equal(secondPeterBuild.status,0,secondPeterBuild.stderr||secondPeterBuild.stdout);
const secondPeterBytes=await readFile(PETER_CORRECTION);
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readJson(resolve(CORRECTIONS,file))));
const correctionOperations=correctionDocuments.flatMap(item=>item.operations||item.ops||[]);
const state=materialize([...document.operations,...correctionOperations]);

const matrikelPrivate=resolve(ROOT,'../matrikel/privat');
const matrikelMigration=resolve(matrikelPrivate,'migrering-2026-08-01');
const matrikelDocuments=await Promise.all(['initial-ops.json','ui-metadata-ops.json','approved-excel-ops.json'].map(file=>readJson(resolve(matrikelMigration,file))));
const familyBatch=await readJson(resolve(matrikelPrivate,'familjemodell-2026-08-02-batch.json'));
const matrikelPeterCorrectionDirectory=resolve(matrikelPrivate,'korrigeringar/utdata-peter-2026-08-03');
const matrikelPeterCorrectionFiles=(await readdir(matrikelPeterCorrectionDirectory)).filter(file=>file.endsWith('.json')).sort();
const matrikelPeterCorrectionDocuments=await Promise.all(matrikelPeterCorrectionFiles.map(file=>readJson(resolve(matrikelPeterCorrectionDirectory,file))));
const matrikelPeterCorrectionOperations=matrikelPeterCorrectionDocuments.flatMap(item=>item.ops||item.operations||[]);
const matrikelState=materialize([...matrikelDocuments.flatMap(item=>item.operations),...familyBatch.ops,...matrikelPeterCorrectionOperations]);
const entityRows=type=>matrikelState.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const familyContext=buildFamilyContext({people:entityRows('person'),relations:entityRows('relation'),familyUnits:entityRows('family-unit'),kinGroups:entityRows(KIN_GROUP_TYPE)});

await test('startmastern och rättelserna innehåller 171 båtar och giltiga operationer',()=>{
  assert.equal(sha256(firstPeterBytes),sha256(secondPeterBytes));
  document.operations.forEach(validateOperation);
  correctionOperations.forEach(validateOperation);
  assert.equal(new Set([...document.operations,...correctionOperations].map(operation=>operation.op_id)).size,document.operations.length+correctionOperations.length);
  assert.equal(state.listEntities('boat').length,171);
  assert.equal(state.listEntities('boat-person-link').length,176);
  assert.ok(state.listEntities('family').length>4);
  assert.equal(state.listEntities('boat-family-link').length,9);
  for(const family of decisions.families)assert.ok(state.listEntities('family').some(entity=>entity.entity_id===family.id),family.id);
});

await test('Sommarsol och Neretnieks Majsol hålls isär med källkritiskt registreringsår',()=>{
  const holm=state.getEntity('boat','majsol_holm');
  const neretnieks=state.getEntity('boat','majsol_neretnieks');
  assert.equal(holm.fields.namn,'Majsol');
  assert.deepEqual(holm.fields.tidigare_namn,['Sommarsol']);
  assert.equal(holm.fields.typ,'S/S');
  assert.equal(holm.fields.modell,'Örnjolle');
  assert.equal(holm.fields.dopar,null);
  assert.equal(holm.fields.ar,2013);
  assert.ok(holm.fields.period.includes('registrerad 2013'));
  assert.ok(holm.fields.period.includes('tidpunkter är okända'));
  assert.equal(holm.fields.agare,'Inger Bethge → Anna Holm');
  assert.equal(neretnieks.fields.typ,'S/S');
  assert.equal(neretnieks.fields.ar,null);
  assert.ok(neretnieks.fields.period.includes('1975/77'));
  assert.ok(neretnieks.fields.period.includes('händelsetidpunkt okänd'));
  assert.ok(neretnieks.fields.agarkedja.every(item=>item.ar===null));
  assert.ok(state.getEntity('boat-person-link','majsol_holm--ingerbethge'));
  assert.equal(state.getEntity('boat-person-link','majsol_holm--annaholm').fields.role,'ägare enligt uppgift registrerad 2013 (ägarbytets tidpunkt okänd)');
  assert.ok(state.getEntity('boat-person-link','majsol_neretnieks--ivarsneretnieks'));
  assert.ok(state.getEntity('boat-person-link','majsol_neretnieks--margaretaneretnieks'));
});

await test('de två bekräftade Korpholmen runt-farkosterna är källspårbara utan påstått ägarskap',()=>{
  const aquilo=state.getEntity('boat','aquilogunillo');
  const kareMorfarBengt=state.getEntity('boat','käremorfarbengt');
  assert.equal(aquilo.fields.namn,'Aquilo Gunillo');
  assert.equal(aquilo.fields.period,'belagd i Korpholmen runt 2020');
  assert.equal(aquilo.fields.agare,null);
  assert.equal(kareMorfarBengt.fields.namn,'Käre Morfar Bengt');
  assert.equal(kareMorfarBengt.fields.modell,'Kanadensare (tävlingsklass)');
  assert.equal(kareMorfarBengt.fields.agare,null);
  assert.equal(state.listEntities('boat-person-link').filter(link=>['aquilogunillo','käremorfarbengt'].includes(link.fields.boat_id)).length,0);
});

await test('Junior Peter hålls isär från Peter-Pedal i båtägandet',()=>{
  assert.equal(state.getEntity('boat-person-link','lassemaja--peterholm'),null);
  assert.equal(state.getEntity('boat-person-link','tillfälligheten--peterholm'),null);
  assert.equal(state.getEntity('boat-person-link','lassemaja--peterneretnieks').fields.person_display_name,'Peter Neretnieks');
  assert.equal(state.getEntity('boat-person-link','tillfälligheten--peterneretnieks').fields.person_id,'peterneretnieks');
  assert.equal(state.getEntity('boat-person-link','bossanova--peterholm').fields.person_id,'peterholm');
});

await test('Filifjonkan I och II är två båtar utan att ettans historik går förlorad',()=>{
  const first=state.getEntity('boat','filifjonkaniii');
  const second=state.getEntity('boat','filifjonkanii');
  assert.equal(first.fields.namn,'Filifjonkan I');
  assert.equal(first.fields.modell,'M/S Selko');
  assert.deepEqual(first.fields.tidigare_namn,['Filifjonkan']);
  assert.equal(first.fields.ar,1962);
  assert.equal(first.fields.images.length,1);
  assert.equal(second.fields.namn,'Filifjonkan II');
  assert.equal(second.fields.modell,'M/S Askeladden');
  assert.equal(second.fields.ar,null);
  assert.deepEqual(second.fields.images,[]);
  assert.ok(state.getEntity('boat-person-link','filifjonkaniii--perolofbethge'));
  assert.ok(state.getEntity('boat-family-link','filifjonkanii--family--bethge'));
});

await test('alla säkra båt-person-länkar pekar på en person i Matrikeln',async()=>{
  const people=new Set(matrikelState.listEntities('person').map(person=>person.entity_id));
  for(const link of state.listEntities('boat-person-link'))assert.ok(people.has(link.fields.person_id),link.fields.person_id);
  for(const family of state.listEntities('family'))for(const personId of family.fields.explicit_person_ids||[])assert.ok(people.has(personId),personId);
});

await test('godkända och avvisade kopplingar hålls isär',()=>{
  const links=new Set(state.listEntities('boat-person-link').map(link=>`${link.fields.boat_id}--${link.fields.person_id}`));
  const supersededApprovedLinks=new Set(correctionDocuments.flatMap(document=>(document.supersedes||[]).map(item=>item.entity_id)));
  for(const link of decisions.approved_person_links){
    const key=`${link.boat_id}--${link.person_id}`;
    if(supersededApprovedLinks.has(key))assert.ok(!links.has(key),`Återkallad länk är fortfarande aktiv: ${link.boat_id} → ${link.person_id}`);
    else assert.ok(links.has(key),`Godkänd länk saknas: ${link.boat_id} → ${link.person_id}`);
  }
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
  assert.ok(app.includes("opsRoot:'/matrikel/ops',readOnly:true"));
  assert.ok(app.includes("new ReadOnlyMaster({store,cacheKey:'matrikel'})"));
  assert.ok(app.includes('personNameForLink(link)'));
});

await test('webbgränssnittet kan ändra båtar, länkar och bilder',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const html=await readFile(resolve(ROOT,'index.html'),'utf8');
  assert.ok(app.includes("repository.setField('boat'"));
  assert.ok(app.includes("entityType:'boat-person-link'"));
  assert.ok(app.includes("entityType:'boat-family-link'"));
  assert.ok(app.includes("entityType:'boat-group-link'"));
  assert.ok(app.includes('person:${person.id}'));
  assert.ok(app.includes('id="relation-link-search"'));
  assert.ok(app.includes('FAMILY_UNIT_TYPE'));
  assert.ok(app.includes('KIN_GROUP_TYPE'));
  assert.ok(app.includes('boatMatchesConnectionTarget'));
  assert.ok(app.includes('../matrikel/?person='));
  assert.ok(html.includes('id="connection-filter-search"'));
  assert.ok(html.includes('id="connection-filter-browse"'));
  assert.ok(html.includes('id="filter-panel"'));
  assert.ok(html.includes('id="view-panel"'));
  assert.ok(html.includes('id="active-filters"'));
  assert.equal(html.includes('id="person-filter"'),false);
  assert.ok(html.includes('role="combobox"'));
  assert.ok(html.includes('Person, familj eller släkt'));
  assert.ok(html.includes('stabil FAMILJ'));
  assert.ok(html.includes('stabil SLÄKT'));
  assert.ok(app.includes('putBlobImmutable'));
  assert.ok(app.includes("repository.deleteEntities"));
  assert.equal((app.match(/repository\.upsertFields\(/g)||[]).length,3);
});

await test('anknytningsfiltret söker personer och bläddrar bland stabila grupper utan äldre etiketter', async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const html=await readFile(resolve(ROOT,'index.html'),'utf8');
  assert.ok(app.includes('searchFamilyTargets'));
  assert.ok(app.includes('searchPeopleForConnection'));
  assert.ok(app.includes('searchableFamilyTargets'));
  assert.ok(app.includes('renderConnectionBrowseResults'));
  assert.ok(app.includes('renderPersonScopeResults'));
  assert.equal(html.includes('<select id="connection-filter"'),false);
  assert.equal(html.includes('Äldre etiketter'),false);
  assert.equal(app.includes('<optgroup label="Äldre familjeetiketter"'),false);
  const personResults=searchPeopleForConnection(familyContext.people,'Svahn');
  assert.ok(personResults.length>0);
  const results=searchFamilyTargets(familyContext,'Svahn');
  assert.ok(results.length>0);
  assert.ok(results.every(result=>[KIN_GROUP_TYPE,'family-unit'].includes(result.type)));
  const hierarchy=familyBrowseHierarchy(familyContext);
  const visitedGroups=[];
  const visit=group=>{visitedGroups.push(group.id);for(const child of hierarchy.childGroupsByParentId.get(group.id)||[])visit(child)};
  hierarchy.roots.forEach(visit);
  assert.equal(new Set(visitedGroups).size,familyContext.kinGroups.length);
  const placedFamilies=[...hierarchy.familyUnitsByKinGroupId.values()].flat().length+hierarchy.unlinkedFamilyUnits.length;
  assert.equal(placedFamilies,familyContext.familyUnits.length);
});

await test('en vald person erbjuder person, nära familj och tillhörande släktnivåer',()=>{
  const family=familyContext.familyUnits.find(item=>(item.kin_group_ids||[]).length&&targetMemberDetails({type:FAMILY_UNIT_TYPE,id:item.id},familyContext).length);
  assert.ok(family);
  const personId=targetMemberDetails({type:FAMILY_UNIT_TYPE,id:family.id},familyContext)[0].person_id;
  const scopes=personScopeTargets(personId,familyContext);
  assert.ok(scopes.some(target=>target.type==='person'&&target.id===personId));
  assert.ok(scopes.some(target=>target.type===FAMILY_UNIT_TYPE&&target.id===family.id));
  for(const kinGroupId of family.kin_group_ids)assert.ok(scopes.some(target=>target.type===KIN_GROUP_TYPE&&target.id===kinGroupId),kinGroupId);
});

await test('båtar kan länkas till stabil FAMILJ eller SLÄKT med ärvd synlighet',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const filter=await readFile(resolve(ROOT,'src/connection-filter.js'),'utf8');
  const core=await readFile(resolve(REPO,'packages/core/family-context.js'),'utf8');
  assert.ok(filter.includes('familySelectionMatches'));
  assert.ok(app.includes('targetMemberDetails'));
  assert.ok(app.includes("field:'target_code'"));
  assert.ok(app.includes("field:'confirmed',value:true"));
  assert.ok(core.includes('anchors_and_descendants'));
  assert.ok(core.includes("return 'FAMILJ'"));
  assert.ok(core.includes("return 'SLÄKT'"));
});

await test('SLÄKT-filter hittar personlänkar och godkända äldre familjeetiketter',()=>{
  const targetGroup=familyContext.kinGroups.find(group=>group.reference_code==='SLÄKT-006');
  assert.equal(targetGroup.name,'Lena–Böving');
  const target={type:KIN_GROUP_TYPE,id:targetGroup.id};
  const boats=state.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));
  const personLinks=state.listEntities('boat-person-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  const familyLinks=state.listEntities('boat-family-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  const groupLinks=state.listEntities('boat-group-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  assert.equal(groupLinks.length,0);
  const hits=boats.filter(boat=>familySelectionMatches({
    target,
    context:familyContext,
    structuredAssociations:groupLinks.filter(link=>link.boat_id===boat.id),
    linkedPersonIds:personLinks.filter(link=>link.boat_id===boat.id).map(link=>link.person_id),
    legacyFamilyLabels:[boat.slakt,...familyLinks.filter(link=>link.boat_id===boat.id).map(link=>link.family_name)],
  }));
  assert.equal(hits.length,29);
  assert.ok(hits.some(boat=>boat.namn==='Gerry'));
  assert.ok(hits.some(boat=>boat.namn==='Pancho'));
  const value=`${KIN_GROUP_TYPE}:${targetGroup.id}`;
  const connectionHits=boats.filter(boat=>boatMatchesConnection({
    boat,
    value,
    context:familyContext,
    personLinks:personLinks.filter(link=>link.boat_id===boat.id),
    groupLinks:groupLinks.filter(link=>link.boat_id===boat.id),
    legacyFamilyLabels:[boat.slakt,...familyLinks.filter(link=>link.boat_id===boat.id).map(link=>link.family_name)],
  }));
  assert.deepEqual(connectionHits.map(boat=>boat.id),hits.map(boat=>boat.id));
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
  const publishedFilter=await readFile(resolve(REPO,'batregister/src/connection-filter.js'),'utf8');
  const publishedCore=await readFile(resolve(REPO,'batregister/core/data-layer.js'),'utf8');
  const serviceWorker=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedFilter.includes("../core/family-context.js"));
  assert.ok(publishedCore.includes("./storage/indexeddb.js"));
  assert.ok(serviceWorker.includes("?'../../packages/core':'./core'"));
  assert.ok(serviceWorker.includes("'./src/config.js'"));
  assert.ok(serviceWorker.includes("'./src/connection-filter.js'"));
});

await test('OAuth-returen kan skickas till båda apparna',async()=>{
  const root=await readFile(resolve(REPO,'index.html'),'utf8');
  const rootApp=await readFile(resolve(REPO,'src/app.js'),'utf8');
  const bootstrap=await readFile(resolve(REPO,'src/app-family-bootstrap.js'),'utf8');
  const matrikel=await readFile(resolve(REPO,'apps/matrikel/src/app.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(rootApp.includes('korpholmen:oauth-return'));
  assert.ok(bootstrap.includes('mirrorSharedDropboxCredential'));
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
