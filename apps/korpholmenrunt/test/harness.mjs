import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';
import { KLASSER, KLASSSTANDARD_METHOD, klassnamn, standardklass } from '../src/klassstandard.js';
import { parseRaceTime } from '../src/time.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-02');
const SOURCE=resolve(ROOT,'privat/kallkopior/Korpholmen runt konv.mdb');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

await test('Access-källan kan migreras reproducerbart till operationsmaster och SQLite',()=>{
  const migration=spawnSync(process.execPath,['verktyg/bygg-startmaster.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(migration.status,0,migration.stderr||migration.stdout);
  const sqlite=spawnSync('python3',['verktyg/bygg-sqlite.py'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(sqlite.status,0,sqlite.stderr||sqlite.stdout);
});

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
document.operations.forEach(validateOperation);
const state=materialize(document.operations);
const list=type=>state.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const results=list('race-result');
const editions=list('race-edition');
const links=list('race-person-link');
const participantPlaceholders=list('race-participant-placeholder');
const people=list('person-ref');
const boats=list('boat-ref');
const notes=list('source-note');

await test('v2-startmastern använder nya och avgränsade device-id:n',()=>{
  const retired=new Set(['migration-korpholmenrunt-2026-08-02','migration-korpholmenrunt-granskning-2026-08-02']);
  assert.deepEqual(new Set(document.device_ids),new Set(['migration-korpholmenrunt-2026-08-04-v2','migration-korpholmenrunt-granskning-2026-08-04-v2']));
  assert.equal(document.device_id,'migration-korpholmenrunt-2026-08-04-v2');
  assert.ok(document.operations.every(operation=>document.device_ids.includes(operation.device_id)));
  assert.ok(document.operations.every(operation=>!retired.has(operation.device_id)));
});

await test('appinmatning accepterar minuter och sekunder men inte tvetydiga tretalstider',()=>{
  assert.deepEqual(parseRaceTime('21:05'),{seconds:1265,status:'tolkad'});
  assert.deepEqual(parseRaceTime('21,05?'),{seconds:1265,status:'osäker'});
  assert.deepEqual(parseRaceTime('21:05:30'),{seconds:null,status:'ogiltigt format'});
  assert.deepEqual(parseRaceTime('21:67'),{seconds:null,status:'ogiltig sekunddel'});
});

await test('samtliga 363 källrader är bevarade som resultat eller källnotering',async()=>{
  assert.equal(results.length,357);
  assert.equal(editions.length,38);
  assert.equal(notes.length,6);
  assert.equal(results.length+notes.length,document.counts.source_rows);
  assert.equal(new Set(results.map(item=>item.source_row_id)).size,results.length);
  assert.ok(results.every(item=>item.raw_row&&item.year&&item.class_name&&item.course_code&&item.time_raw));
  assert.ok(results.every(item=>item.class_id&&item.class_match_status==='manuell'&&item.class_match_method===KLASSSTANDARD_METHOD));
  const dagen=results.find(item=>item.class_raw==='Dagen');assert.ok(dagen);assert.equal(dagen.class_name,'Rodd');assert.equal(dagen.class_id,'rodd');
  const paddel=results.find(item=>item.class_raw==='Paddel');assert.ok(paddel);assert.equal(paddel.boat_name_raw,'Anita');assert.equal(paddel.class_id,'kajak-2');
  const jolle=results.find(item=>item.class_raw==='jolle*');assert.ok(jolle);assert.equal(jolle.boat_name_raw,'Näcken');assert.equal(jolle.class_id,'segel');
  const digest=createHash('sha256').update(await readFile(SOURCE)).digest('hex');
  assert.equal(digest,document.source_sha256);
});

await test('klassstandarden samlar beslutade varianter och bevarar separata grenar',()=>{
  const expected=new Map([
    ['Canadian','Kanadensare'],['Canadian*','Kanadensare'],['kanad','Kanadensare'],['Can','Kanadensare'],
    ['Kajak 1','Kajak 1'],['K1','Kajak 1'],['Kajak 2?','Kajak 2'],['K2','Kajak 2'],
    ['rodd?*','Rodd'],['Dagen','Rodd'],['Segel?','Segel'],['S','Segel'],
    ['optimist*','Optimist'],['Gummijolle','Gummi'],['','Okänd'],['?','Okänd'],['Övrigt','Övrigt'],
    ['rodel','Rodd'],['jolle*','Segel'],['Paddel','Kajak 2'],
    ['Örnjolle','Örnjolle'],['rodd+segel','Rodd + segel'],
  ]);
  for(const [raw,name] of expected){assert.equal(klassnamn(raw),name,raw);assert.ok(standardklass(raw)?.id,raw)}
  assert.equal(new Set(KLASSER.map(item=>item.id)).size,KLASSER.length);
  assert.ok(KLASSER.some(item=>item.id==='ovrigt'&&item.name==='Övrigt'));
});

await test('namnkopplingar använder stabila ID:n från Matrikeln och Båtregistret',()=>{
  const personIds=new Set(people.map(item=>item.external_id));
  const boatIds=new Set(boats.map(item=>item.external_id));
  assert.equal(people.length,214);
  assert.equal(boats.length,168);
  assert.ok(links.filter(item=>item.person_id).every(item=>personIds.has(item.person_id)));
  assert.ok(results.filter(item=>item.boat_id).every(item=>boatIds.has(item.boat_id)));
  assert.ok(links.some(item=>item.person_id==='lottasvahn'&&item.match_status==='föreslagen'&&!item.confirmed));
  for(const id of ['linje3','rödeorm','snusmumriken'])assert.ok(boatIds.has(id));
});

await test('med flera är ett strukturerat och avslutat deltagarobjekt',()=>{
  assert.equal(participantPlaceholders.length,1);
  const placeholder=participantPlaceholders[0];
  assert.equal(placeholder.id,'race-participant-placeholder:med-flera');
  assert.equal(placeholder.label,'Med flera');
  assert.equal(placeholder.terminal,true);
  const placeholderLinks=links.filter(item=>item.placeholder_id===placeholder.id);
  assert.equal(placeholderLinks.length,9);
  assert.ok(placeholderLinks.every(item=>item.participant_kind==='placeholder'&&item.confirmed===true&&item.match_status==='strukturerad-placeholder'&&!item.person_id));
  assert.ok(links.filter(item=>item.source_raw_name&&/m\s*\.?\s*fl/iu.test(item.source_raw_name)).some(item=>item.raw_name==='Peter'&&!item.confirmed));
  assert.ok(!links.some(item=>!item.confirmed&&/^(?:m\s*\.?\s*fl\.?|med flera)$/iu.test(item.raw_name)));
});

await test('osäkra träffar lämnas i granskningskö utan att källnamnet skrivs över',()=>{
  assert.equal(links.length,578);
  assert.equal(links.filter(item=>item.match_status==='kopplad').length,document.counts.person_links_connected);
  assert.equal(results.filter(item=>item.boat_match_status==='kopplad').length,document.counts.boats_connected);
  assert.ok(links.some(item=>item.match_status==='föreslagen'&&item.raw_name&&item.candidate_ids.length));
  assert.ok(links.some(item=>item.match_method==='entydigt förnamn'&&item.person_id&&!item.confirmed));
  assert.ok(links.some(item=>item.match_status==='saknas'&&item.raw_name));
  assert.ok(results.some(item=>item.boat_match_status!=='kopplad'&&item.boat_name_raw));
});

await test('analysdatabasen har främmande nycklar och index för topplistor',()=>{
  const script=`import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\nassert not db.execute('PRAGMA foreign_key_check').fetchall()\nassert db.execute('select count(*) from result').fetchone()[0]==357\nassert db.execute('select count(*) from participant_placeholder').fetchone()[0]==1\nassert db.execute(\"select count(*) from result_person where placeholder_id='race-participant-placeholder:med-flera' and confirmed=1\").fetchone()[0]==9\ncolumns={row[1] for row in db.execute('PRAGMA table_info(result)').fetchall()}\nassert {'class_raw','class_id','class_name','class_match_status','class_match_method'} <= columns\nperson_columns={row[1] for row in db.execute('PRAGMA table_info(result_person)').fetchall()}\nassert {'participant_kind','placeholder_id','source_raw_name','source_parent_field'} <= person_columns\nplan=str(db.execute(\"EXPLAIN QUERY PLAN SELECT * FROM result WHERE year=2001 AND class_id='kajak-2' AND course_code='S'\").fetchall())\nassert 'idx_result_year_class_course' in plan\nprint(db.execute('select count(*) from result_person where person_id is not null').fetchone()[0])`;
  const query=spawnSync('python3',['-c',script,resolve(PRIVATE,'korpholmenrunt.sqlite')],{encoding:'utf8'});
  assert.equal(query.status,0,query.stderr||query.stdout);
});

await test('appen har redigering, rekord, profiler, duell, export och matchningskö',async()=>{
  const [html,app,styles,matchingStyles,serviceWorker]=await Promise.all(['index.html','src/app.js','styles.css','matchning.css','sw.js'].map(file=>readFile(resolve(ROOT,file),'utf8')));
  const sharedServiceWorkerClient=await readFile(resolve(REPO,'packages/core/pwa/korpholmen-service-worker.js'),'utf8');
  for(const label of ['Översikt','Alla resultat','Topptider','Människor & båtar','Öduellen','Granska &amp; matcha'])assert.ok(html.includes(label));
  for(const capability of ['saveResult','exportCsv','renderRecords','renderProfiles','renderDuel','renderMatching','reviewPending','rankEligible','approveResult','boatRegisterCell','crewRegisterCell','boatCandidateControls','personCandidateControls','confirmBoatCandidate','confirmPersonCandidate','splitParticipantSortNames','participantSplitOptions','participantMayBeMerged','participantSplitControls','splitParticipantLink','participantSourceNote','orderedParticipantLinks','participantSortEntries','participantPlaceholderConnected','participantLinkResolved','participantPlaceholders','preservesPlaceholder','parseRaceTime','bootstrapLocal','sortResults','sortResultRows','sortHeader','updateInlineBoat','updateInlinePerson','updateInlineClass','inlineTargetReady','runInlineUpdate','classStandardizationPlan','applyClassStandard'])assert.ok(app.includes(capability));
  for(const control of ['edit-review-status','edit-review-issues','edit-person-1-id','edit-person-2-id','edit-person-3-id'])assert.ok(html.includes(control));
  assert.ok(app.includes("field:'review_status'"));
  assert.ok(app.includes("field:'review_issues'"));
  assert.ok(app.includes('await repository.upsertFields(entries)'));
  assert.ok(app.includes("['Tävlande 1',result.captain_raw]"));
  assert.ok(app.includes("['Tävlande 2',result.crew_1_raw]"));
  assert.ok(app.includes("['Tävlande 3',result.crew_2_raw]"));
  assert.ok(app.includes("method:'valt i resultatdialogen'"));
  assert.ok(app.includes('participantRole(link)'));
  assert.ok(matchingStyles.includes('.tavlandegrupp'));
  assert.ok(app.includes('matchContext(result,bMap)'));
  assert.equal((app.match(/\$\{matchContext\(result,bMap\)\}/g)||[]).length,3);
  assert.ok(matchingStyles.includes('.matchkontext'));
  assert.ok(app.includes("opsRoot:'/korpholmenrunt/ops'"));
  assert.ok(app.includes("opsRoot:'/matrikel/ops',readOnly:true"));
  assert.ok(app.includes('mergePersonReferences(storedPeople(),matrikelMaster)'));
  assert.ok(app.includes("source_id:prior?.source_id??'race-source:user'"));
  assert.ok(app.includes("!result||reviewPending(result)?'granskning krävs':'granskad'"));
  assert.ok(app.includes('Båt / register'));
  assert.ok(app.includes('Tävlande / register'));
  assert.ok(app.includes('Förslag i Matrikeln:'));
  assert.ok(app.includes('Förslag i Båtregistret:'));
  assert.ok(app.includes('data-action="open-register"'));
  assert.ok(matchingStyles.includes('.registeretikett'));
  assert.ok(matchingStyles.includes('.registeretikett.platshallare'));
  assert.ok(matchingStyles.includes('.registernamn'));
  assert.ok(app.includes('Strukturerad platshållare'));
  assert.ok(app.includes('Okända ytterligare tävlande · avslutad fråga'));
  assert.ok(app.includes('Startkopian kan bara aktiveras i en tom lokal databas'));
  assert.ok(app.includes("const deviceIds=new Set(data.device_ids||[data.device_id])"));
  assert.ok(app.includes('data-sort-key='));
  assert.ok(app.includes('inline-person-options'));
  assert.ok(app.includes('inline-boat-options'));
  assert.ok(app.includes('inline-class-options'));
  assert.ok(app.includes('data-action="quick-confirm-person"'));
  assert.ok(app.includes('data-action="quick-confirm-boat"'));
  assert.ok(app.includes('data-action="split-participant"'));
  assert.ok(app.includes('data-action="toggle-split-review"'));
  assert.ok(app.includes("field:'participant_structure_status'"));
  assert.ok(app.includes('Källrad före delning:'));
  assert.ok(app.includes("field:'class_match_method'"));
  assert.ok(app.includes("field:'class_id'"));
  assert.ok(html.includes('standardize-classes'));
  assert.ok(app.includes("field:'match_method',value:'bekräftat från förslag i resultatlistan'"));
  assert.ok(matchingStyles.includes('.sortknapp'));
  assert.ok(matchingStyles.includes('.snabbval'));
  assert.ok(matchingStyles.includes('.sorteringsperson'));
  assert.ok(matchingStyles.includes('.forslagsknapp'));
  assert.ok(matchingStyles.includes('.namndelning'));
  assert.ok(matchingStyles.includes('.delningsfilter'));
  assert.ok(app.includes('registerKorpholmenServiceWorker'));
  assert.ok(sharedServiceWorkerClient.includes("updateViaCache: 'none'"));
  assert.ok(serviceWorker.includes("if(request.mode==='navigate')"));
  assert.ok(serviceWorker.includes("fetch(request,{cache:'no-store'})"));
  assert.ok(serviceWorker.indexOf("fetch(request,{cache:'no-store'})")<serviceWorker.indexOf("caches.match('./index.html')"));
  assert.ok(styles.includes('@media(max-width:'));
});

await test('publiceringspaketet är datafritt och länkat från appnavet',async()=>{
  const build=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr||build.stdout);
  const [publishedApp,publishedClasses,publishedTime,publishedCore,root]=await Promise.all([
    readFile(resolve(REPO,'korpholmenrunt/src/app.js'),'utf8'),
    readFile(resolve(REPO,'korpholmenrunt/src/klassstandard.js'),'utf8'),
    readFile(resolve(REPO,'korpholmenrunt/src/time.js'),'utf8'),
    readFile(resolve(REPO,'korpholmenrunt/core/data-layer.js'),'utf8'),
    readFile(resolve(REPO,'index.html'),'utf8'),
  ]);
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedApp.includes("../core/master-data.js"));
  assert.ok(publishedApp.includes("../core/read-only-master.js"));
  assert.equal(publishedApp.includes('../../../packages/core/'),false);
  assert.ok(publishedApp.includes("./klassstandard.js"));
  assert.ok(publishedClasses.includes('Kanadensare'));
  assert.ok(publishedTime.includes('parseRaceTime'));
  assert.ok(publishedCore.includes('./storage/indexeddb.js'));
  assert.ok(root.includes('./korpholmenrunt/'));
  assert.ok(root.includes('En installerad app'));
  for(const result of results.slice(0,40))assert.equal(publishedApp.includes(JSON.stringify(result.boat_name_raw)),false);
});

console.log(`\n${passed} Korpholmen runt-kontrakt godkända.`);
