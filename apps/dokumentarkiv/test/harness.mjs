import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DropboxTransport, materialize, validateOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/aktuell-startmaster');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const sourceManifest=await readJson(resolve(PRIVATE,'källfiler.json'));
const state=materialize(document.operations);
const documents=state.listEntities('document').map(entity=>({id:entity.entity_id,...entity.fields}));
const entities=state.listEntities('archive-entity').map(entity=>({id:entity.entity_id,...entity.fields}));
const summary=state.listEntities('archive-summary').map(entity=>({id:entity.entity_id,...entity.fields}))[0];

await test('startmastern innehåller hela det aktuella arkivet och giltiga operationer',()=>{
  document.operations.forEach(validateOperation);
  assert.equal(documents.length,document.counts.documents);
  assert.ok(documents.length>=194);
  assert.equal(document.counts.excluded_documents,0);
  assert.equal(entities.length,document.counts.entities);
  assert.equal(new Set(documents.map(item=>item.id)).size,documents.length);
  assert.ok(documents.every(item=>item.title&&item.document_date&&item.transcript&&item.source_path));
  assert.ok(documents.every(item=>Array.isArray(item.entity_ids)));
  assert.ok(documents.every(item=>Array.isArray(item.entity_links)));
  assert.ok(documents.every(item=>item.entity_links.every(link=>link.relation==='nämns'&&link.source_label&&link.evidence_quote)));
  assert.ok(documents.every(item=>JSON.stringify(item.entity_ids)===JSON.stringify(item.entity_links.map(link=>link.entity_id))));
  assert.ok(documents.every(item=>Array.isArray(item.story_track_ids)));
  assert.ok(documents.every(item=>Array.isArray(item.content_images)));
  assert.ok(documents.every(item=>Array.isArray(item.source_files)&&item.source_files.length>0));
  assert.ok(documents.flatMap(item=>item.source_files).every(file=>file.display_copy&&file.display_copy.sha256&&file.display_copy.blob_path));
  assert.ok(documents.flatMap(item=>item.source_files).every(file=>['image/jpeg','application/pdf'].includes(file.display_copy.mime_type)));
  assert.ok(documents.flatMap(item=>item.source_files).every(file=>/^\/dokumentarkiv\/kallor\/laskopior\/[a-f0-9]{64}\.(?:jpg|pdf)$/.test(file.display_copy.blob_path)));
  assert.equal(sourceManifest.version,1);
  assert.ok(sourceManifest.files.length>400);
  assert.equal(new Set(sourceManifest.files.map(file=>file.blob_path)).size,sourceManifest.files.length);
  assert.ok(sourceManifest.files.every(file=>file.source_file&&file.sha256&&['image/jpeg','application/pdf'].includes(file.mime_type)));
  assert.ok(sourceManifest.files.every(file=>/^\/dokumentarkiv\/kallor\/laskopior\/[a-f0-9]{64}\.(?:jpg|pdf)$/.test(file.blob_path)));
  assert.ok(documents.flatMap(item=>item.content_images).length>=6);
  assert.ok(documents.flatMap(item=>item.content_images).every(image=>/^\/dokumentarkiv\/bilder\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(image.blob_path)));
  assert.ok(documents.every(item=>item.transcript_sha256&&Number.isInteger(item.word_count)));
  assert.ok(documents.every(item=>['färdig','kontroll behövs'].includes(item.status)||/^granskad(?:\s|\(|$)/iu.test(item.status)));
  assert.ok(documents.every(item=>![item.title,item.document_date,item.document_type,item.status].some(value=>/^(?:".*"|'.*')$/.test(value))));
  assert.equal(summary.total_documents,documents.length);
  assert.equal(summary.inbox_total_files,summary.inbox_referenced_files+summary.inbox_pending_files.length);
  assert.equal(summary.inbox_pending_files.length,document.counts.pending_inbox_files);
  assert.ok(Array.isArray(summary.story_tracks)&&summary.story_tracks.length>=6);
  assert.ok(documents.some(item=>item.title==='Protokoll från Korpholmens Båtklubbs årsmöte'));
  assert.ok(documents.some(item=>item.title==='Protokoll vid extra sammanträde med Korpholmens Båtklubb på Yxlan'));
  const protocol1979=documents.find(item=>item.document_date==='1979-07-21'&&item.title==='Protokoll vid Korpholmens Båtklubbs årsmöte');
  assert.ok(protocol1979);
  assert.equal(protocol1979.image_count,7);
  assert.equal(protocol1979.content_images.length,10);
  assert.equal(documents.find(item=>item.title==='Korpholmens Båtklubbs förvaltningsberättelse för 1954').id,'document:01-digitaliserade-dokument-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-1955-04-12-korpholmens-batklubbs-forvaltningsberattelse-for-1954-avskrift-md');
});

await test('Dropbox-synken återhämtar sig när en gammal mappcursor saknar sökväg',async()=>{
  const transport=new DropboxTransport({
    accessToken:'test-token',
    opsRoot:'/dokumentarkiv/ops',
    fetchImpl:async()=>({
      ok:false,
      status:409,
      headers:{get:()=>null},
      text:async()=>JSON.stringify({error_summary:'path/not_found/..'}),
    }),
  });
  await assert.rejects(
    ()=>transport.listChanges('cursor-från-arkiv-mappen'),
    error=>error?.name==='CursorResetError',
  );
});

await test('registerkopplingar skiljer exakt träff, granskning och saknad entitet',()=>{
  const byId=new Map(entities.map(entity=>[entity.id,entity]));
  assert.equal(byId.get('person:nilshenrikhedström').external_id,'nilshenrikhedström');
  assert.equal(byId.get('person:nilshenrikhedström').url,'../matrikel/?person=nilshenrikhedstr%C3%B6m');
  assert.equal(byId.get('boat:atlanta').external_id,'atlanta');
  assert.equal(byId.get('boat:galejan').external_id,'galejan');
  assert.equal(byId.get('boat:pumsbullan').name,'Pumsbullan');
  assert.equal(byId.get('boat:pumsbullan').match_status,'kopplad');
  assert.equal(byId.get('person:thomashedström').name,'Thomas Hedström');
  assert.equal(byId.get('person:thomashedström').match_status,'kopplad');
  assert.equal(byId.get('place:brockholmen').name,'Brokholmen');
  assert.equal(byId.get('person:rolf-une-olöst').match_status,'saknas');
  assert.equal(byId.get('person:bibbihedström').external_id,'bibbihedström');
  assert.equal(byId.get('person:mats-sam-une-olöst').match_status,'granska');
  assert.ok(entities.some(entity=>entity.match_status==='lokal'));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:atlanta')));
  assert.ok(documents.some(item=>item.entity_ids.includes('boat:gungafin')));
  assert.ok(documents.find(item=>item.title==='Protokoll från Korpholmens Båtklubbs årsmöte').entity_ids.includes('person:bibbihedström'));
  const winterMeeting1954=documents.find(item=>item.document_date==='1954-01-29');
  assert.ok(winterMeeting1954);
  assert.equal(winterMeeting1954.entity_ids.includes('boat:dagen'),false);
  assert.equal(documents.find(item=>item.document_date==='1967-10-05').entity_ids.includes('boat:ingenting'),false);
});

await test('verktyget för ersatta dokument kräver exakt antal och skriver först med --apply',async()=>{
  const scratch=await mkdtemp(resolve(tmpdir(),'korpholmen-dokument-cleanup-'));
  try {
    const dropboxRoot=resolve(scratch,'Dropbox/Appar/Korpholmen');
    const opsRoot=resolve(dropboxRoot,'dokumentarkiv/ops');
    await mkdir(opsRoot,{recursive:true});
    const clock=Math.max(...document.operations.map(operation=>Number(String(operation.hlc).split('-')[0])||0))+1000;
    const staleOperation={
      op_id:'cleanup-test-source:1',device_id:'cleanup-test-source',seq:1,
      entity_type:'document',entity_id:'document:ersatt-test',field:'title',value:'Ersatt testdokument',
      hlc:`${clock}-000001-cleanup-test-source`,schema_version:1,
    };
    await writeFile(resolve(opsRoot,'remote.json'),`${JSON.stringify({ops:[...document.operations,staleOperation]})}\n`);
    const script=resolve(ROOT,'verktyg/aterkalla-ersatta-dokument.mjs');
    const mismatch=spawnSync(process.execPath,[script,dropboxRoot,'--expected','2'],{encoding:'utf8'});
    assert.notEqual(mismatch.status,0);
    assert.match(mismatch.stderr,/fann 1 ersatta poster/);
    const preview=spawnSync(process.execPath,[script,dropboxRoot,'--expected','1'],{encoding:'utf8'});
    assert.equal(preview.status,0,preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).mode,'preview');
    assert.deepEqual(await readdir(opsRoot),['remote.json']);
    const applied=spawnSync(process.execPath,[script,dropboxRoot,'--expected','1','--apply'],{encoding:'utf8'});
    assert.equal(applied.status,0,applied.stderr);
    const report=JSON.parse(applied.stdout);
    assert.equal(report.mode,'apply');
    assert.equal(report.tombstones,1);
    assert.ok(report.batch_file.includes('/dokumentarkiv/ops/'));
    assert.ok(report.batch_file.includes('cleanup-dokumentarkiv-'));
    assert.ok(report.batch_file.endsWith('.json'));
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
});

await test('webbgränssnittet söker, filtrerar och visar hela avskriften',async()=>{
  const [html,app,styles]=await Promise.all(['index.html','src/app.js','styles.css'].map(file=>readFile(resolve(ROOT,file),'utf8')));
  assert.ok(html.includes('id="search"'));
  assert.ok(html.includes('id="entity-filter"'));
  assert.ok(html.includes('id="view-tabs"'));
  assert.ok(html.includes('id="status-filter"'));
  assert.ok(html.includes('data-view="overview"'));
  assert.ok(html.includes('data-view="question"'));
  assert.ok(html.includes('Korpholmens Båtklubbs arkiv – Protokoll & handlingar'));
  assert.ok(html.includes('Korpholmens Båtklubbs arkiv'));
  assert.ok(html.includes('Dokumenttyper, flera kan väljas'));
  assert.ok(app.includes('document.transcript'));
  assert.ok(app.includes('renderOverview'));
  assert.ok(app.includes('renderTracks'));
  assert.ok(app.includes('renderConnections'));
  assert.ok(app.includes('renderPlaces'));
  assert.ok(app.includes('renderWork'));
  assert.ok(app.includes('renderQuestion'));
  assert.ok(app.includes('transcriptVersions'));
  assert.ok(app.includes('syncContentImages'));
  assert.ok(app.includes('requestSourceFile'));
  assert.ok(app.includes('loadSourcePage'));
  assert.equal(app.includes('downloadSourceOriginal'),false);
  assert.equal(app.includes('Hämta bevarat original'),false);
  assert.ok(app.includes("action === 'show-sources'"));
  assert.ok(app.includes('Visa källbilder'));
  assert.ok(app.includes('Endast den sida du väljer hämtas'));
  assert.equal(app.includes('syncSourceFiles'),false);
  assert.equal(app.includes('loadCachedSourceFiles'),false);
  assert.ok(app.includes("document.addEventListener('visibilitychange'"));
  assert.ok(app.includes("opsRoot: '/dokumentarkiv/ops'"));
  assert.ok(app.includes("opsRoot: '/fastigheter/ops', readOnly: true"));
  assert.ok(app.includes("new ReadOnlyMaster({ store, cacheKey: 'fastigheter' })"));
  assert.ok(app.includes("new ReadOnlyMaster({ store, cacheKey: 'kartdata' })"));
  assert.ok(app.includes("opsRoot: '/kartdata/ops', readOnly: true"));
  assert.ok(app.includes('fastigheterMaster, kartdataMaster }'));
  assert.ok(app.includes("location.pathname.includes('/apps/dokumentarkiv/')"));
  assert.ok(app.includes("new URL('dokumentarkiv/', redirectUri())"));
  assert.ok(app.includes("searchParams.get('document')"));
  assert.ok(app.includes("searchParams.set('document', id)"));
  assert.ok(app.includes('categories: new Set()'));
  assert.ok(app.includes('ui.categories.has(document.category)'));
  assert.ok(app.includes('ui.categories.add(category)'));
  assert.ok(app.includes('ui.categories.delete(category)'));
  assert.ok(app.includes('ui.categories.clear()'));
  assert.ok(styles.includes('.papper'));
  assert.ok(styles.includes('.arsmatris'));
  assert.ok(styles.includes('.sambandskarta'));
  assert.ok(styles.includes('.platskarta'));
  assert.ok(styles.includes('.innehallsbild'));
  assert.ok(styles.includes('.kallfilsvisare'));
  assert.ok(styles.includes('@media print'));
});

await test('enstegsflödet planerar säker arkivering och hashbaserad bildpublicering',async()=>{
  const [publisher,archiver,seed]=await Promise.all([
    readFile(resolve(ROOT,'verktyg/publicera-dokumentarkiv.mjs'),'utf8'),
    readFile(resolve(ROOT,'verktyg/arkivera-inkorgsoriginal.mjs'),'utf8'),
    readFile(resolve(ROOT,'verktyg/skriv-dropbox-startmaster.mjs'),'utf8'),
  ]);
  assert.ok(publisher.includes('aterstallArkivering'));
  assert.ok(publisher.includes('planeraArkivering'));
  assert.ok(archiver.includes('Hash ändrades vid flytt'));
  assert.ok(archiver.includes('02 Arkiverade inkorgsoriginal'));
  assert.ok(seed.includes('innehållsbilder.json'));
  assert.ok(seed.includes('källfiler.json'));
  assert.ok(seed.includes('dokumentarkiv\\/kallor'));
  assert.ok(seed.includes('kallor\\/laskopior'));
  assert.equal(seed.includes('original|laskopior'),false);
  assert.ok(seed.includes('COPYFILE_EXCL'));
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
  const rootApp=await readFile(resolve(REPO,'src/app.js'),'utf8');
  const bootstrap=await readFile(resolve(REPO,'src/app-family-bootstrap.js'),'utf8');
  assert.ok(rootApp.includes('korpholmen:oauth-return'));
  assert.ok(bootstrap.includes('mirrorSharedDropboxCredential'));
  assert.ok(root.includes('href="./dokumentarkiv/"'));
  assert.equal(root.includes('href="./arkiv/"'),false);
  assert.ok(root.includes('Dokumentarkiv'));
  assert.ok(app.includes('registerKorpholmenServiceWorker({ sourceTree: isSourceTree })'));
});

console.log(`\n${passed} Dokumentarkiv-kontrakt godkända.`);
