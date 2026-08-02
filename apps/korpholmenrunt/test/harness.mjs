import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

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
const people=list('person-ref');
const boats=list('boat-ref');
const notes=list('source-note');

await test('samtliga 363 källrader är bevarade som resultat eller källnotering',async()=>{
  assert.equal(results.length,357);
  assert.equal(editions.length,38);
  assert.equal(notes.length,6);
  assert.equal(results.length+notes.length,document.counts.source_rows);
  assert.equal(new Set(results.map(item=>item.source_row_id)).size,results.length);
  assert.ok(results.every(item=>item.raw_row&&item.year&&item.class_name&&item.course_code&&item.time_raw));
  const digest=createHash('sha256').update(await readFile(SOURCE)).digest('hex');
  assert.equal(digest,document.source_sha256);
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

await test('osäkra träffar lämnas i granskningskö utan att källnamnet skrivs över',()=>{
  assert.equal(links.length,574);
  assert.equal(links.filter(item=>item.match_status==='kopplad').length,document.counts.person_links_connected);
  assert.equal(results.filter(item=>item.boat_match_status==='kopplad').length,document.counts.boats_connected);
  assert.ok(links.some(item=>item.match_status==='föreslagen'&&item.raw_name&&item.candidate_ids.length));
  assert.ok(links.some(item=>item.match_method==='entydigt förnamn'&&item.person_id&&!item.confirmed));
  assert.ok(links.some(item=>item.match_status==='saknas'&&item.raw_name));
  assert.ok(results.some(item=>item.boat_match_status!=='kopplad'&&item.boat_name_raw));
});

await test('analysdatabasen har främmande nycklar och index för topplistor',()=>{
  const script=`import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\nassert not db.execute('PRAGMA foreign_key_check').fetchall()\nassert db.execute('select count(*) from result').fetchone()[0]==357\nplan=str(db.execute(\"EXPLAIN QUERY PLAN SELECT * FROM result WHERE year=2001 AND class_name='Kajak 2' AND course_code='S'\").fetchall())\nassert 'idx_result_year_class_course' in plan\nprint(db.execute('select count(*) from result_person where person_id is not null').fetchone()[0])`;
  const query=spawnSync('python3',['-c',script,resolve(PRIVATE,'korpholmenrunt.sqlite')],{encoding:'utf8'});
  assert.equal(query.status,0,query.stderr||query.stdout);
});

await test('appen har redigering, rekord, profiler, duell, export och matchningskö',async()=>{
  const [html,app,styles]=await Promise.all(['index.html','src/app.js','styles.css'].map(file=>readFile(resolve(ROOT,file),'utf8')));
  for(const label of ['Översikt','Alla resultat','Topptider','Människor & båtar','Öduellen','Matcha registren'])assert.ok(html.includes(label));
  for(const capability of ['saveResult','exportCsv','renderRecords','renderProfiles','renderDuel','renderMatching'])assert.ok(app.includes(capability));
  assert.ok(app.includes("opsRoot:'/korpholmenrunt/ops'"));
  assert.ok(app.includes("source_id:prior?.source_id??'race-source:user'"));
  assert.ok(styles.includes('@media(max-width:'));
});

await test('publiceringspaketet är datafritt och länkat från appnavet',async()=>{
  const build=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr||build.stdout);
  const [publishedApp,publishedCore,root]=await Promise.all([
    readFile(resolve(REPO,'korpholmenrunt/src/app.js'),'utf8'),
    readFile(resolve(REPO,'korpholmenrunt/core/data-layer.js'),'utf8'),
    readFile(resolve(REPO,'index.html'),'utf8'),
  ]);
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedCore.includes('./storage/indexeddb.js'));
  assert.ok(root.includes('./korpholmenrunt/'));
  assert.ok(root.includes('Fem separata verktyg'));
  for(const result of results.slice(0,40))assert.equal(publishedApp.includes(JSON.stringify(result.boat_name_raw)),false);
});

console.log(`\n${passed} Korpholmen runt-kontrakt godkända.`);
