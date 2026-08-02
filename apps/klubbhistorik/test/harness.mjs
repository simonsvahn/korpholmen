import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat');
const MIGRATION=resolve(PRIVATE,'migrering-2026-08-02');
const SOURCES=resolve(PRIVATE,'kallkopior');
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;

async function test(name,action){
  try{await action();passed+=1;console.log(`✓ ${name}`)}
  catch(error){console.error(`✗ ${name}`);throw error}
}

function buildMigration(){
  const result=spawnSync(process.execPath,['verktyg/bygg-startmaster.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
}

buildMigration();
const firstBytes=await readFile(resolve(MIGRATION,'initial-ops.json'));
const firstReportBytes=await readFile(resolve(MIGRATION,'kontrollrapport.json'));
buildMigration();
const secondBytes=await readFile(resolve(MIGRATION,'initial-ops.json'));
const secondReportBytes=await readFile(resolve(MIGRATION,'kontrollrapport.json'));
const document=JSON.parse(secondBytes);
const report=JSON.parse(secondReportBytes);
const state=materialize(document.operations);
const rows=type=>state.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const releases=rows('matrikel-release');
const sourceRows=rows('source-row');
const people=rows('person-occurrence');
const boats=rows('boat-occurrence');
const personRefs=rows('person-ref');
const boatRefs=rows('boat-ref');

await test('startmastern byggs deterministiskt byte för byte',()=>{
  assert.equal(sha256(firstBytes),sha256(secondBytes));
  assert.equal(sha256(firstReportBytes),sha256(secondReportBytes));
  assert.equal(document.operations_sha256,sha256(Buffer.from(JSON.stringify(document.operations))));
});

await test('alla operationer är giltiga och unika',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(new Set(document.operations.map(operation=>operation.op_id)).size,document.operations.length);
  assert.equal(document.counts.operations,document.operations.length);
  assert.equal(document.counts.operations,10138);
});

await test('källkopiorna är kryptografiskt låsta',async()=>{
  const paths={historic:'matriklar-1980-1986.md',current:'vem-ar-vem-2025.txt',people:'matrikel-initial-archive.json',boats:'batregister-initial-ops.json',decisions:'godkanda-personmatchningar.json'};
  for(const [key,file] of Object.entries(paths))assert.equal(sha256(await readFile(resolve(SOURCES,file))),document.source_hashes[key],key);
});

await test('tre utgåvor och alla 244 medlemsrader finns kvar',()=>{
  assert.deepEqual(releases.map(release=>release.year).sort((a,b)=>a-b),[1980,1986,2025]);
  assert.deepEqual(report.release_counts['matrikel-1980'],{person_rows:41,boat_source_rows:32,boat_occurrences:46,connected_person_rows:40,unresolved_person_rows:1});
  assert.deepEqual(report.release_counts['matrikel-1986'],{person_rows:47,boat_source_rows:35,boat_occurrences:51,connected_person_rows:44,unresolved_person_rows:3});
  assert.deepEqual(report.release_counts['matrikel-2025'],{person_rows:156,boat_source_rows:0,boat_occurrences:0,connected_person_rows:156,unresolved_person_rows:0});
  assert.equal(people.length,244);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1980'&&item.membership_status==='active').length,35);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1980'&&item.membership_status==='passive').length,6);
});

await test('alla källrader och båtförekomster redovisas utan tyst bortfall',()=>{
  assert.equal(sourceRows.length,311);
  assert.equal(boats.length,97);
  assert.equal(new Set(sourceRows.map(row=>row.id)).size,sourceRows.length);
  assert.ok(sourceRows.every(row=>typeof row.raw_text==='string'&&row.raw_text.length>0));
  assert.ok(people.every(item=>typeof item.raw_text==='string'&&item.raw_text.length>0));
  assert.ok(boats.every(item=>typeof item.raw_text==='string'&&item.raw_text.length>0));
  for(const row of sourceRows)for(const id of row.occurrence_ids||[])assert.ok(people.some(item=>item.id===id)||boats.some(item=>item.id===id),id);
});

await test('person- och båtkopplingar pekar bara på respektive master',()=>{
  const personIds=new Set(personRefs.map(ref=>ref.external_id));
  const boatIds=new Set(boatRefs.map(ref=>ref.external_id));
  assert.equal(personIds.size,214);
  assert.equal(boatIds.size,168);
  for(const item of people.filter(row=>row.person_id&&row.confirmed))assert.ok(personIds.has(item.person_id),item.person_id);
  for(const item of boats.filter(row=>row.boat_id&&row.confirmed))assert.ok(boatIds.has(item.boat_id),item.boat_id);
});

await test('osäkra identiteter ligger öppet i granskningskön',()=>{
  const unresolved=people.filter(item=>!item.person_id||!item.confirmed);
  assert.equal(unresolved.length,4);
  assert.deepEqual(unresolved.map(item=>`${item.release_id}:${item.person_name_raw}`).sort(),['matrikel-1980:Gunnel Söderberg','matrikel-1986:Agneta Åkerman','matrikel-1986:Annika Söderberg','matrikel-1986:Gunnel Söderberg']);
  assert.ok(unresolved.every(item=>item.confirmed===false&&Array.isArray(item.candidate_ids)));
  assert.equal(report.counts.unresolved_boats,14);
});

await test('dubbletter och ogiltiga källvärden rättas inte bort',()=>{
  assert.equal(report.duplicate_person_groups.length,2);
  assert.ok(report.duplicate_person_groups.some(group=>group.raw_names.includes('Peter Neretnieks')&&group.raw_names.includes('Peter Holm')));
  assert.ok(report.duplicate_person_groups.some(group=>group.raw_names.filter(name=>name==='Ted Thunborg').length===2));
  assert.deepEqual(report.invalid_birth_dates.map(item=>item.raw),['200991020']);
});

await test('bara belagda verkliga namnbyten registreras som kandidater',()=>{
  const changes=rows('name-change-candidate');
  assert.equal(changes.length,3);
  assert.deepEqual(changes.map(item=>`${item.from_name} → ${item.to_name}`).sort(),['Christina Une → Christina Lindblom','Lotta Bethge → Lotta Svahn','Peter Neretnieks → Peter Holm']);
  assert.ok(changes.find(item=>item.person_id==='christinakisselindblom').basis.includes('källform Christina Lindbom'));
  assert.ok(changes.every(item=>item.writes_to_person_master===false&&item.status==='belagd kandidat'));
});

await test('fartygskolumnen skapar aldrig ett dolt ägarpåstående',()=>{
  assert.equal(rows('ownership-observation').length,0);
  assert.equal(rows('boat-person-link').length,0);
  assert.ok(boats.every(item=>!Object.hasOwn(item,'person_id')&&!Object.hasOwn(item,'owner_id')));
});

await test('gränssnittet skiljer källa, normalisering och tidsjämförelse',async()=>{
  const [app,html,model]=await Promise.all([readFile(resolve(ROOT,'src/app.js'),'utf8'),readFile(resolve(ROOT,'index.html'),'utf8'),readFile(resolve(ROOT,'DATAMODELL.md'),'utf8')]);
  assert.ok(app.includes('Som källan skrevs'));
  assert.ok(app.includes('Normaliserad värld'));
  assert.ok(app.includes('Frånvaro är inte ett utträde'));
  assert.ok(app.includes("opsRoot:'/klubbhistorik/ops'"));
  assert.ok(app.includes("name:'kbk-klubbhistorik'"));
  assert.ok(html.includes('matriklar över tid'));
  assert.ok(model.includes('HLC på en'));
  assert.ok(model.includes('operation är transaktionstid'));
  assert.ok(model.includes('inte automatiskt vem'));
});

await test('den tänkta apparkitekturen är dokumenterad och länkad',async()=>{
  const appReadmePaths=['matrikel','batregister','fastigheter','arkiv','korpholmenrunt','klubbhistorik'].map(name=>resolve(REPO,'apps',name,'README.md'));
  const [architecture,localArchitecture,rootReadme,localModel,...appReadmes]=await Promise.all([
    readFile(resolve(REPO,'ARKITEKTUR.md'),'utf8'),
    readFile(resolve(ROOT,'ARKITEKTUR.md'),'utf8'),
    readFile(resolve(REPO,'README.md'),'utf8'),
    readFile(resolve(ROOT,'DATAMODELL.md'),'utf8'),
    ...appReadmePaths.map(path=>readFile(path,'utf8')),
  ]);
  for(const name of ['Matrikel','Båtregister','Fastighetshistorik','Dokumentarkiv','Korpholmen runt','Klubbhistorik'])assert.ok(architecture.includes(`**${name}**`),name);
  assert.ok(architecture.includes('härledd, skrivskyddad totalbild'));
  assert.ok(architecture.includes('Ingen app får skriva direkt i en annan apps operationsmapp'));
  assert.ok(architecture.includes('Rena skrivfel, OCR-fel och typografiska variationer'));
  assert.ok((architecture.match(/```mermaid/g)||[]).length>=4);
  assert.ok((localArchitecture.match(/```mermaid/g)||[]).length>=6);
  assert.ok(localArchitecture.includes('ownership-observation'));
  assert.ok(localArchitecture.includes('aldrig genom radparning'));
  assert.ok(rootReadme.includes('[`ARKITEKTUR.md`](ARKITEKTUR.md)'));
  assert.ok(localModel.includes('[`ARKITEKTUR.md`](ARKITEKTUR.md)'));
  assert.ok(appReadmes.every(readme=>readme.includes('ARKITEKTUR.md')));
});

await test('Dropbox-startmastern kan seedas utan överskrivning',async()=>{
  const [seed,appPackage]=await Promise.all([
    readFile(resolve(ROOT,'verktyg/skriv-dropbox-startmaster.mjs'),'utf8'),
    readFile(resolve(ROOT,'package.json'),'utf8'),
  ]);
  assert.ok(seed.includes("endsWith('/Dropbox/Appar/Korpholmen')"));
  assert.ok(seed.includes("'/klubbhistorik/ops'"));
  assert.ok(seed.includes("{flag:'wx'}"));
  assert.ok(seed.includes('Befintlig operationsbatch skiljer sig och skrivs inte över'));
  assert.equal(JSON.parse(appPackage).scripts['seed:dropbox'],'node verktyg/skriv-dropbox-startmaster.mjs');
});

await test('publiceringsbygget är datafritt och länkat från appfamiljen',async()=>{
  const result=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const [publishedApp,publishedCore,rootHtml]=await Promise.all([readFile(resolve(REPO,'klubbhistorik/src/app.js'),'utf8'),readFile(resolve(REPO,'klubbhistorik/core/data-layer.js'),'utf8'),readFile(resolve(REPO,'index.html'),'utf8')]);
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(!publishedApp.includes('person-occurrence:matrikel-'));
  assert.ok(publishedCore.includes("./storage/indexeddb.js"));
  assert.ok(rootHtml.includes('./klubbhistorik/'));
  assert.ok(rootHtml.includes('Sex separata verktyg'));
});

console.log(`\n${passed} Klubbhistorik-kontrakt godkända.`);
