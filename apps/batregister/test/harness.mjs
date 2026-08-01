import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-01');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const imageManifest=await readJson(resolve(PRIVATE,'bildmanifest.json'));
const state=materialize(document.operations);

await test('startmastern innehåller 168 båtar och giltiga operationer',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(state.listEntities('boat').length,168);
  assert.equal(state.listEntities('boat-person-link').length,146);
});

await test('alla säkra båt-person-länkar pekar på en person i Matrikeln',async()=>{
  const path=resolve(ROOT,'../matrikel/privat/migrering-2026-08-01');
  const docs=await Promise.all(['initial-ops.json','ui-metadata-ops.json','approved-excel-ops.json'].map(file=>readJson(resolve(path,file))));
  const matrikel=materialize(docs.flatMap(item=>item.operations));
  const people=new Set(matrikel.listEntities('person').map(person=>person.entity_id));
  for(const link of state.listEntities('boat-person-link'))assert.ok(people.has(link.fields.person_id),link.fields.person_id);
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
  assert.ok(app.includes("opsRoot:'/ops'"));
});

await test('webbgränssnittet kan ändra båtar, länkar och bilder',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(app.includes("repository.setField('boat'"));
  assert.ok(app.includes("entityType:'boat-person-link'"));
  assert.ok(app.includes('putBlobImmutable'));
  assert.ok(app.includes("repository.deleteEntities"));
});

await test('publiceringsbygget är datafritt',()=>{
  const result=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

await test('OAuth-returen kan skickas till båda apparna',async()=>{
  const root=await readFile(resolve(REPO,'index.html'),'utf8');
  const matrikel=await readFile(resolve(REPO,'apps/matrikel/src/app.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(root.includes('korpholmen:oauth-return'));
  assert.ok(root.includes('matrikel/'));
  assert.ok(root.includes('batregister/'));
  assert.ok(matrikel.includes("fromSourceTree ? '../../' : '../'"));
  assert.ok(boats.includes("fromSourceTree ? '../../' : '../'"));
});

await test('service workers rensar bara sina egna cacher',async()=>{
  const matrikel=await readFile(resolve(REPO,'apps/matrikel/sw.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(matrikel.includes("key.startsWith('korpholmen-matrikel-')"));
  assert.ok(boats.includes("key.startsWith('korpholmen-batregister-')"));
});

console.log(`\n${passed} Båtregister-kontrakt godkända.`);
