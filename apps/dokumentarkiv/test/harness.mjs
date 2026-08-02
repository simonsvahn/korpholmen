import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-02-42-handlingar');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const state=materialize(document.operations);
const documents=state.listEntities('document').map(entity=>({id:entity.entity_id,...entity.fields}));
const entities=state.listEntities('archive-entity').map(entity=>({id:entity.entity_id,...entity.fields}));

await test('startmastern innehåller 42 publicerbara handlingar och giltiga operationer',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(documents.length,42);
  assert.equal(entities.length,document.counts.entities);
  assert.equal(new Set(documents.map(item=>item.id)).size,42);
  assert.ok(documents.every(item=>item.title&&item.document_date&&item.transcript&&item.source_path));
  assert.ok(documents.every(item=>Array.isArray(item.entity_ids)));
  assert.ok(documents.every(item=>['färdig','kontroll behövs'].includes(item.status)));
  assert.equal(document.counts.excluded_documents,1);
  assert.equal(document.excluded_documents[0].status,'pågår');
  assert.equal(documents.some(item=>item.title==='Protokoll vid sammanträde i Korpholmens Båtklubb'),false);
  assert.ok(documents.some(item=>item.title==='Protokoll från Korpholmens Båtklubbs årsmöte'));
  assert.ok(documents.some(item=>item.title==='Protokoll vid extra sammanträde med Korpholmens Båtklubb på Yxlan'));
  assert.equal(documents.find(item=>item.title==='Korpholmens Båtklubbs förvaltningsberättelse för 1954').id,'document:01-digitaliserade-dokument-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-avskrift-md');
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
  assert.equal(byId.get('person:bibbihedström').external_id,'bibbihedström');
  assert.equal(byId.get('person:mats-sam-une-olöst').match_status,'granska');
  assert.ok(entities.some(entity=>entity.match_status==='lokal'));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:atlanta')));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:gungafin')));
  assert.ok(documents.find(item=>item.title==='Protokoll från Korpholmens Båtklubbs årsmöte').entity_ids.includes('person:bibbihedström'));
});

await test('webbgränssnittet söker, filtrerar och visar hela avskriften',async()=>{
  const [html,app,styles]=await Promise.all(['index.html','src/app.js','styles.css'].map(file=>readFile(resolve(ROOT,file),'utf8')));
  assert.ok(html.includes('id="search"'));
  assert.ok(html.includes('id="entity-filter"'));
  assert.ok(html.includes('id="reader"'));
  assert.ok(html.includes('Korpholmens Båtklubbs arkiv – Protokoll & handlingar'));
  assert.ok(html.includes('Korpholmens Båtklubbs arkiv'));
  assert.ok(html.includes('Dokumenttyper, flera kan väljas'));
  assert.ok(app.includes('document.transcript'));
  assert.ok(app.includes("opsRoot: '/dokumentarkiv/ops'"));
  assert.ok(app.includes("location.pathname.includes('/apps/dokumentarkiv/')"));
  assert.ok(app.includes("new URL('dokumentarkiv/', redirectUri())"));
  assert.ok(app.includes('categories: new Set()'));
  assert.ok(app.includes('ui.categories.has(document.category)'));
  assert.ok(app.includes('ui.categories.add(category)'));
  assert.ok(app.includes('ui.categories.delete(category)'));
  assert.ok(app.includes('ui.categories.clear()'));
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
  assert.ok(root.includes('href="./dokumentarkiv/"'));
  assert.equal(root.includes('href="./arkiv/"'),false);
  assert.ok(root.includes('Dokumentarkiv'));
  assert.ok(app.includes("isSourceTree ? '../../' : '../'"));
});

console.log(`\n${passed} Dokumentarkiv-kontrakt godkända.`);
