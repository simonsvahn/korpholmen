import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';
import { boatOptionLabel, boatReferenceLines } from '../src/boat-reference.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat');
const MIGRATION=resolve(PRIVATE,'migrering-2026-08-02');
const SOURCES=resolve(PRIVATE,'kallkopior');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const SUPPLEMENT_CORRECTION=resolve(CORRECTIONS,'2026-08-03-matriklar-1991-1998.json');
const SUPPLEMENT_REPORT=resolve(MIGRATION,'kontrollrapport-1991-1998.json');
const SYNC_CORRECTION=resolve(CORRECTIONS,'2026-08-03-synkade-matriklar.json');
const SYNC_REPORT=resolve(MIGRATION,'kontrollrapport-synkade-matriklar.json');
const TED_CORRECTION=resolve(CORRECTIONS,'2026-08-03-ted-thunborg-dublett.json');
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;

async function test(name,action){
  try{await action();passed+=1;console.log(`✓ ${name}`)}
  catch(error){console.error(`✗ ${name}`);throw error}
}

function buildMigration(){
  for(const script of ['verktyg/bygg-startmaster.mjs','verktyg/bygg-tillaggs-matriklar.mjs','verktyg/bygg-synkade-matriklar.mjs','verktyg/bygg-korrigering-ted-thunborg.mjs']){
    const result=spawnSync(process.execPath,[script],{cwd:ROOT,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
  }
}

buildMigration();
const firstBytes=await readFile(resolve(MIGRATION,'initial-ops.json'));
const firstReportBytes=await readFile(resolve(MIGRATION,'kontrollrapport.json'));
const firstSupplementBytes=await readFile(SUPPLEMENT_CORRECTION);
const firstSupplementReportBytes=await readFile(SUPPLEMENT_REPORT);
const firstSyncBytes=await readFile(SYNC_CORRECTION);
const firstSyncReportBytes=await readFile(SYNC_REPORT);
const firstTedBytes=await readFile(TED_CORRECTION);
buildMigration();
const secondBytes=await readFile(resolve(MIGRATION,'initial-ops.json'));
const secondReportBytes=await readFile(resolve(MIGRATION,'kontrollrapport.json'));
const secondSupplementBytes=await readFile(SUPPLEMENT_CORRECTION);
const secondSupplementReportBytes=await readFile(SUPPLEMENT_REPORT);
const secondSyncBytes=await readFile(SYNC_CORRECTION);
const secondSyncReportBytes=await readFile(SYNC_REPORT);
const secondTedBytes=await readFile(TED_CORRECTION);
const document=JSON.parse(secondBytes);
const report=JSON.parse(secondReportBytes);
const supplementDocument=JSON.parse(secondSupplementBytes);
const supplementReport=JSON.parse(secondSupplementReportBytes);
const syncDocument=JSON.parse(secondSyncBytes);
const syncReport=JSON.parse(secondSyncReportBytes);
const tedDocument=JSON.parse(secondTedBytes);
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const correctionOperations=correctionDocuments.flatMap(item=>item.operations||item.ops||[]);
const state=materialize([...document.operations,...correctionOperations]);
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
  assert.equal(sha256(firstSupplementBytes),sha256(secondSupplementBytes));
  assert.equal(sha256(firstSupplementReportBytes),sha256(secondSupplementReportBytes));
  assert.equal(sha256(firstSyncBytes),sha256(secondSyncBytes));
  assert.equal(sha256(firstSyncReportBytes),sha256(secondSyncReportBytes));
  assert.equal(sha256(firstTedBytes),sha256(secondTedBytes));
  assert.equal(document.operations_sha256,sha256(Buffer.from(JSON.stringify(document.operations))));
  assert.equal(supplementDocument.operations_sha256,sha256(Buffer.from(JSON.stringify(supplementDocument.operations))));
  assert.equal(syncDocument.operations_sha256,sha256(Buffer.from(JSON.stringify(syncDocument.operations))));
  assert.equal(tedDocument.operations_sha256,sha256(Buffer.from(JSON.stringify(tedDocument.operations))));
});

await test('alla operationer är giltiga och unika',()=>{
  document.operations.forEach(validateOperation);
  correctionOperations.forEach(validateOperation);
  assert.equal(new Set(document.operations.map(operation=>operation.op_id)).size,document.operations.length);
  assert.equal(new Set([...document.operations,...correctionOperations].map(operation=>operation.op_id)).size,document.operations.length+correctionOperations.length);
  assert.equal(document.counts.operations,document.operations.length);
  assert.equal(document.counts.operations,10138);
  assert.equal(supplementDocument.counts.operations,supplementDocument.operations.length);
  assert.equal(supplementDocument.counts.operations,10970);
  assert.equal(syncDocument.counts.operations,syncDocument.operations.length);
  assert.equal(syncDocument.counts.operations,92701);
  assert.equal(tedDocument.operations.length,5);
});

await test('källkopiorna är kryptografiskt låsta',async()=>{
  const paths={historic:'matriklar-1980-1986.md',current:'vem-ar-vem-2025.txt',people:'matrikel-initial-archive.json',boats:'batregister-initial-ops.json',decisions:'godkanda-personmatchningar.json'};
  for(const [key,file] of Object.entries(paths))assert.equal(sha256(await readFile(resolve(SOURCES,file))),document.source_hashes[key],key);
  assert.equal(sha256(await readFile(resolve(SOURCES,'matriklar-1991-1998.json'))),supplementDocument.source_sha256);
  assert.equal(Object.keys(supplementReport.source_file_hashes).length,6);
  assert.ok(Object.values(supplementReport.source_file_hashes).every(value=>/^[a-f0-9]{64}$/.test(value)));
});

await test('alla matrikel-JSON följer samma schema och källhashar',()=>{
  const result=spawnSync(process.execPath,['verktyg/validera-matrikel-json.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const validation=JSON.parse(result.stdout);
  assert.equal(validation.schema_version,1);
  assert.equal(validation.documents,41);
  assert.equal(validation.releases,23);
  assert.equal(validation.source_files,77);
  assert.equal(validation.member_rows_in_primary_documents,2819);
  assert.equal(validation.boat_occurrences_in_primary_documents,559);
  assert.equal(validation.source_duplicate_groups.length,1);
  assert.equal(validation.source_duplicate_groups[0].key,'ted thunborg|2021');
});

await test('23 utgåvor och 2 818 normaliserade medlemsförekomster finns kvar',()=>{
  assert.equal(releases.length,23);
  assert.deepEqual(releases.map(release=>release.id).sort(),Object.keys(syncReport.release_counts).sort());
  assert.deepEqual(report.release_counts['matrikel-1980'],{person_rows:41,boat_source_rows:32,boat_occurrences:46,connected_person_rows:40,unresolved_person_rows:1});
  assert.deepEqual(report.release_counts['matrikel-1986'],{person_rows:47,boat_source_rows:35,boat_occurrences:51,connected_person_rows:44,unresolved_person_rows:3});
  assert.deepEqual(report.release_counts['matrikel-2025'],{person_rows:156,boat_source_rows:0,boat_occurrences:0,connected_person_rows:156,unresolved_person_rows:0});
  assert.deepEqual(supplementReport.release_counts['matrikel-1991'].person_categories,{active:58,passive:10,junior:26,corresponding:2});
  assert.deepEqual(supplementReport.release_counts['matrikel-1998'].person_categories,{active:63,passive:2,junior:42,corresponding:4});
  assert.equal(supplementReport.release_counts['matrikel-1991'].person_rows,96);
  assert.equal(supplementReport.release_counts['matrikel-1998'].person_rows,111);
  assert.equal(people.length,2818);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1980'&&item.membership_status==='active').length,35);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1980'&&item.membership_status==='passive').length,6);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1980'&&item.membership_status==='junior').length,30);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1982').length,77);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1987').length,85);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1988').length,89);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1991'&&item.membership_status==='junior').length,26);
  assert.equal(people.filter(item=>item.release_id==='matrikel-1998'&&item.membership_status==='corresponding').length,4);
});

await test('alla källrader och båtförekomster redovisas utan tyst bortfall',()=>{
  assert.equal(sourceRows.length,3848);
  assert.equal(sourceRows.filter(row=>row.id.startsWith('source-row:canonical:')).length,3192);
  assert.equal(boats.length,559);
  assert.equal(new Set(sourceRows.map(row=>row.id)).size,sourceRows.length);
  assert.ok(sourceRows.every(row=>typeof row.raw_text==='string'&&(row.raw_text.length>0||row.category==='blank')));
  assert.ok(people.every(item=>typeof item.raw_text==='string'&&item.raw_text.length>0));
  assert.ok(boats.every(item=>typeof item.raw_text==='string'&&item.raw_text.length>0));
  for(const row of sourceRows)for(const id of row.occurrence_ids||[])assert.ok(people.some(item=>item.id===id)||boats.some(item=>item.id===id),id);
  assert.equal(sourceRows.filter(row=>row.release_id==='matrikel-1991'&&row.kind==='boat'&&row.id.startsWith('source-row:canonical:')).length,71);
  assert.equal(sourceRows.filter(row=>row.release_id==='matrikel-1998'&&row.kind==='boat'&&row.id.startsWith('source-row:canonical:')).length,67);
  assert.equal(boats.filter(item=>item.release_id==='matrikel-1991').length,93);
  assert.equal(boats.filter(item=>item.release_id==='matrikel-1998').length,119);
  assert.equal(people.find(item=>item.release_id==='matrikel-1991'&&item.person_name_raw==='Per-Olof Bethge').source_annotation,'orange överstrykning i källfotot');
  assert.equal(boats.find(item=>item.release_id==='matrikel-1991'&&item.boat_name_raw==='Lasse-Maja (1985').source_annotation,'slutparentes saknas i källan');
});

await test('person- och båtkopplingar pekar bara på respektive master',()=>{
  const personIds=new Set(personRefs.map(ref=>ref.external_id));
  const boatIds=new Set(boatRefs.map(ref=>ref.external_id));
  assert.equal(personIds.size,214);
  assert.equal(boatIds.size,169);
  for(const item of people.filter(row=>row.person_id&&row.confirmed))assert.ok(personIds.has(item.person_id),item.person_id);
  for(const item of boats.filter(row=>row.boat_id&&row.confirmed))assert.ok(boatIds.has(item.boat_id),item.boat_id);
});

await test('osäkra identiteter ligger öppet i granskningskön',()=>{
  const unresolved=people.filter(item=>!item.person_id||!item.confirmed);
  assert.equal(unresolved.length,182);
  const originalUnresolved=unresolved.filter(item=>['matrikel-1980','matrikel-1986'].includes(item.release_id)&&!item.id.includes(':canonical:'));
  assert.deepEqual(originalUnresolved.map(item=>`${item.release_id}:${item.person_name_raw}`).sort(),['matrikel-1980:Gunnel Söderberg','matrikel-1986:Agneta Åkerman','matrikel-1986:Annika Söderberg','matrikel-1986:Gunnel Söderberg']);
  assert.ok(unresolved.every(item=>item.confirmed===false&&Array.isArray(item.candidate_ids)));
  assert.equal(supplementReport.unresolved_people.length,43);
  assert.equal(report.counts.unresolved_boats,14);
  assert.equal(supplementReport.unresolved_boats.length,31);
  assert.equal(boats.filter(item=>!item.boat_id||!item.confirmed).length,70);
});

await test('alla båtreferenser bär full strukturerad metadata och får entydiga etiketter',()=>{
  assert.equal(boatRefs.length,169);
  assert.ok(boatRefs.every(item=>item.snapshot_version===2&&item.snapshot&&typeof item.snapshot==='object'));
  assert.ok(boatRefs.every(item=>!Object.hasOwn(item.snapshot,'images')));
  const oldMajsol=boatRefs.find(item=>item.external_id==='majsol_neretnieks');
  const newMajsol=boatRefs.find(item=>item.external_id==='majsol_holm');
  assert.match(boatOptionLabel(oldMajsol),/Majsol — Neretnieks.*S\/S.*1975/);
  assert.match(boatOptionLabel(newMajsol),/Majsol — Holm.*M\/S.*2013/);
  assert.notEqual(boatOptionLabel(oldMajsol),boatOptionLabel(newMajsol));
  const unknownBaseName=boatRefs.find(item=>item.external_id==='bustermagnum');
  assert.match(boatOptionLabel(unknownBaseName),/^Buster Magnum/);
  assert.equal(boatReferenceLines(oldMajsol).owner,'Neretnieks → 1993 Junior Åsa');
});

await test('alla redan gjorda manuella båtkopplingar är eftergranskade och korrekta',()=>{
  const expected=new Map([
    ['boat-occurrence:matrikel-1980:019:1','carlphilipper'],
    ['boat-occurrence:matrikel-1980:021:1','myran2'],
    ['boat-occurrence:matrikel-1980:018:1','majsol_neretnieks'],
  ]);
  for(const [id,boatId] of expected){
    const occurrence=boats.find(item=>item.id===id);
    assert.equal(occurrence.boat_id,boatId);
    assert.equal(occurrence.confirmed,true);
    assert.equal(occurrence.audit_status,'eftergranskad');
    assert.match(occurrence.decision_note,/Eftergranskad 2026-08-03/);
  }
});

await test('Majsol 1986 avgörs av typ och år utan att källraden ändras',()=>{
  const occurrence=boats.find(item=>item.id==='boat-occurrence:matrikel-1986:019:1');
  assert.equal(occurrence.raw_text,'S/S Majsol (1975)');
  assert.equal(occurrence.boat_id,'majsol_neretnieks');
  assert.equal(occurrence.match_status,'godkand');
  assert.equal(occurrence.confirmed,true);
  assert.deepEqual(occurrence.candidate_ids,['majsol_neretnieks']);
  const laterMajsols=boats.filter(item=>['matrikel-1991','matrikel-1998'].includes(item.release_id)&&item.boat_name_raw==='Majsol');
  assert.equal(laterMajsols.length,2);
  assert.ok(laterMajsols.every(item=>item.raw_text.includes('S/S Majsol')&&item.boat_id==='majsol_neretnieks'&&item.confirmed===true));
});

await test('Filifjonkan-raderna behåller källformen men länkas till den första båten',()=>{
  const firstRef=boatRefs.find(item=>item.external_id==='filifjonkaniii');
  const secondRef=boatRefs.find(item=>item.external_id==='filifjonkanii');
  assert.equal(firstRef.name,'Filifjonkan I');
  assert.deepEqual(firstRef.aliases,['Filifjonkan']);
  assert.equal(secondRef.name,'Filifjonkan II');
  const occurrences=boats.filter(item=>item.boat_name_raw==='Filifjonkan');
  assert.deepEqual(occurrences.map(item=>item.release_id).sort(),['matrikel-1980','matrikel-1982','matrikel-1986','matrikel-1987','matrikel-1988','matrikel-1991','matrikel-1998']);
  assert.ok(occurrences.every(item=>item.raw_text.includes('Filifjonkan')&&item.boat_id==='filifjonkaniii'&&item.confirmed===true));
  assert.ok(occurrences.every(item=>item.match_status==='godkand'&&['källbelagd identitetsrättning','tidigare källbelagd båtidentitet'].includes(item.match_method)));
});

await test('1991 och 1998 bevarar medlems- och fartygskategorierna',()=>{
  const junior=people.find(item=>item.release_id==='matrikel-1991'&&item.person_name_raw==='Elin Dalaryd');
  const corresponding=people.find(item=>item.release_id==='matrikel-1998'&&item.person_name_raw==='Else Wallén');
  const retired=boats.find(item=>item.release_id==='matrikel-1998'&&item.boat_name_raw==='Annikahn');
  const commaName=boats.find(item=>item.release_id==='matrikel-1998'&&item.boat_name_raw==='Smör, Ost och Sill');
  assert.equal(junior.membership_status,'junior');
  assert.equal(junior.source_page,3);
  assert.equal(corresponding.membership_status,'corresponding');
  assert.equal(corresponding.source_page,3);
  assert.equal(retired.source_category,'deregistered-or-renamed');
  assert.equal(retired.registry_year_raw,'1991-96');
  assert.equal(commaName.registry_year,1994);
  assert.equal(commaName.raw_text,'S/S Smör, Ost och Sill(1994)');
});

await test('källdubbletter bevaras medan Ted Thunborg bara räknas en gång',()=>{
  assert.equal(report.duplicate_person_groups.length,2);
  assert.ok(report.duplicate_person_groups.some(group=>group.raw_names.includes('Peter Neretnieks')&&group.raw_names.includes('Peter Holm')));
  assert.ok(report.duplicate_person_groups.some(group=>group.raw_names.filter(name=>name==='Ted Thunborg').length===2));
  assert.equal(people.some(item=>item.id==='person-occurrence:matrikel-2025:145'),false);
  assert.equal(people.filter(item=>item.release_id==='matrikel-2025'&&item.person_id==='tedthunborg').length,1);
  const duplicateSource=sourceRows.find(item=>item.id==='source-row:canonical:source-document:matrikel-2025:numbers-export:member:145');
  assert.deepEqual(duplicateSource.occurrence_ids,[]);
  assert.match(duplicateSource.normalization_note,/Källdubblett/);
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
  const [app,html,model,matrixCss]=await Promise.all([readFile(resolve(ROOT,'src/app.js'),'utf8'),readFile(resolve(ROOT,'index.html'),'utf8'),readFile(resolve(ROOT,'DATAMODELL.md'),'utf8'),readFile(resolve(ROOT,'matrix.css'),'utf8')]);
  assert.ok(app.includes('Som källan skrevs'));
  assert.ok(app.includes('Normaliserad värld'));
  assert.ok(app.includes('Frånvaro är inte ett utträde'));
  assert.ok(app.includes('all strukturerad metadata från Båtregistret utom bilder'));
  assert.ok(app.includes('Spara ändring'));
  assert.ok(app.includes("junior:'Junior'"));
  assert.ok(app.includes("corresponding:'Korresponderande'"));
  assert.ok(app.includes('Avregistrerat eller namnändrat'));
  assert.ok(app.includes('source_page'));
  assert.ok(app.includes('releaseMoment'));
  assert.ok(app.includes('canonicalSourceRows'));
  assert.ok(app.includes('renderMatrix'));
  assert.ok(app.includes('Tom ruta betyder endast'));
  assert.ok(app.includes('Invalsår visas bara när det uttryckligen står i en källa'));
  assert.ok(app.includes("value!==null&&value!==undefined&&value!==''"));
  assert.ok(app.includes("opsRoot:'/klubbhistorik/ops'"));
  assert.ok(app.includes("name:'kbk-klubbhistorik'"));
  assert.ok(html.includes('matriklar över tid'));
  assert.ok(html.includes('data-view="matris"'));
  assert.ok(html.includes('matrix.css'));
  assert.ok(matrixCss.includes('position:sticky'));
  assert.ok(matrixCss.includes('.matriscell.status-junior'));
  assert.ok(model.includes('HLC på en'));
  assert.ok(model.includes('operation är transaktionstid'));
  assert.ok(model.includes('inte automatiskt vem'));
});

await test('den tänkta apparkitekturen är dokumenterad och länkad',async()=>{
  const appReadmePaths=['matrikel','batregister','fastigheter','dokumentarkiv','korpholmenrunt','klubbhistorik'].map(name=>resolve(REPO,'apps',name,'README.md'));
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
  const [seed,appPackage,config,app]=await Promise.all([
    readFile(resolve(ROOT,'verktyg/skriv-dropbox-startmaster.mjs'),'utf8'),
    readFile(resolve(ROOT,'package.json'),'utf8'),
    readFile(resolve(ROOT,'src/config.js'),'utf8'),
    readFile(resolve(ROOT,'src/app.js'),'utf8'),
  ]);
  assert.ok(seed.includes("endsWith('/Dropbox/Appar/Korpholmen')"));
  assert.ok(seed.includes("'/klubbhistorik/ops'"));
  assert.ok(seed.includes("{flag:'wx'}"));
  assert.ok(seed.includes('Befintlig operationsbatch skiljer sig och skrivs inte över'));
  assert.equal(JSON.parse(appPackage).scripts['seed:dropbox'],'node verktyg/skriv-dropbox-startmaster.mjs');
  assert.ok(config.includes('LOCAL_BOOTSTRAP_URLS'));
  assert.ok(config.includes('2026-08-03-ted-thunborg-dublett.json'));
  assert.ok(app.includes('Full källsäker master inläst lokalt'));
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
