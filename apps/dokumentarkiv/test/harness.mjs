import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-02');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const state=materialize(document.operations);
const documents=state.listEntities('document').map(entity=>({id:entity.entity_id,...entity.fields}));
const entities=state.listEntities('archive-entity').map(entity=>({id:entity.entity_id,...entity.fields}));

await test('startmastern innehåller 21 kompletta handlingar och giltiga operationer',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(documents.length,21);
  assert.equal(entities.length,document.counts.entities);
  assert.equal(new Set(documents.map(item=>item.id)).size,21);
  assert.ok(documents.every(item=>item.title&&item.document_date&&item.transcript&&item.source_path));
  assert.ok(documents.every(item=>Array.isArray(item.entity_ids)));
});

await test('registerkopplingar skiljer exakt träff, granskning och saknad entitet',()=>{
  const byId=new Map(entities.map(entity=>[entity.id,entity]));
  assert.equal(byId.get('person:nilshenrikhedström').external_id,'nilshenrikhedström');
  assert.equal(byId.get('person:nilshenrikhedström').url,'../matrikel/?person=nilshenrikhedstr%C3%B6m');
  assert.equal(byId.get('boat:atlanta').external_id,'atlanta');
  assert.equal(byId.get('boat:galejan').external_id,'galejan');
  assert.equal(byId.get('boat:pumsbullan').match_status,'granska');
  assert.equal(byId.get('person:thomashedström').match_status,'granska');
  assert.equal(byId.get('person:rolf-une-olöst').match_status,'saknas');
  assert.ok(entities.some(entity=>entity.match_status==='lokal'));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:atlanta')));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:gungafin')));
});

await test('webbgränssnittet söker, filtrerar och visar hela avskriften',async()=>{
  const [html,app,styles]=await Promise.all(['index.html','src/app.js','styles.css'].map(file=>readFile(resolve(ROOT,file),'utf8')));
  assert.ok(html.includes('id="search"'));
  assert.ok(html.includes('id="entity-filter"'));
  assert.ok(html.includes('id="reader"'));
  assert.ok(app.includes('document.transcript'));
  assert.ok(app.includes("opsRoot: '/dokumentarkiv/ops'"));
  assert.ok(styles.includes('.papper'));
  assert.ok(styles.includes('@media print'));
});

await test('publiceringsbygget är datafritt',()=>{
  const result=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

await test('publiceringspaketet har en egen offlinebar kärna utan privata avskrifter',async()=>{
  const [publishedApp,publishedCore,serviceWorker]=await Promise.all([
    readFile(resolve(REPO,'dokumentarkiv/src/app.js'),'utf8'),
    readFile(resolve(REPO,'dokumentarkiv/core/data-layer.js'),'utf8'),
    readFile(resolve(ROOT,'sw.js'),'utf8'),
  ]);
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedCore.includes('./storage/indexeddb.js'));
  assert.ok(serviceWorker.includes("?'../../packages/core':'./core'"));
  for(const item of documents)assert.equal(publishedApp.includes(item.title),false);
});

await test('OAuth-returen och appnavigeringen omfattar Dokumentarkivet',async()=>{
  const root=await readFile(resolve(REPO,'index.html'),'utf8');
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(root.includes('korpholmen:oauth-return'));
  assert.ok(root.includes('dokumentarkiv/'));
  assert.ok(app.includes("isSourceTree ? '../../' : '../'"));
});

console.log(`\n${passed} Dokumentarkiv-kontrakt godkända.`);
