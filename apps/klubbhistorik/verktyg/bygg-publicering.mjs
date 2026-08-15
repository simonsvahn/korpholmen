import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles, readOptionalPrivateJson } from '../../../verktyg/publication-guard.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../klubbhistorik');
const CORE=resolve(ROOT,'../../packages/core');
const MASTER_V2=resolve(ROOT,'../../packages/master-data-v2');
const FILES=['index.html','styles.css','boat-reference.css','matrix.css','matrikel-canary.css','manifest.webmanifest','sw.js','src/config.js','src/boat-reference.js'];
const APP_V2_FILES=['src/matrikel-runtime.js','src/matrikel-writer.js'];
const CORE_FILES=['data-layer.js','active-json-master.js','dependency-compatibility.js','generation-cutover.js','runtime-safety.js','master-data.js','membership-model.js','read-only-master.js','domain/canonical.js','domain/hlc.js','domain/materializer.js','domain/operations.js','domain/repository.js','pwa/korpholmen-service-worker.js','storage/indexeddb.js','storage/memory.js','sync/app-family-sync.js','sync/batch.js','sync/batch-progress.js','sync/checkpoint-format.js','sync/dropbox-transport.js','sync/errors.js','sync/http-read-transport.js','sync/memory-transport.js','sync/oauth-flow.js','sync/oauth-pkce.js','sync/shared-dropbox-session.js','sync/sync-engine.js'];
const MASTER_V2_FILES=['index.js','src/domain-contracts.js','src/errors.js','src/family-units.js','src/master.js','src/memory-storage.js','src/repository.js','src/revision-storage.js','src/validation.js'];
for(const relative of FILES){const source=resolve(ROOT,relative);if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const sharedIndex=(await readFile(resolve(ROOT,'index.html'),'utf8')).replaceAll('../../manifest.webmanifest','../manifest.webmanifest').replaceAll('../../icons/korpholmen.svg','../icons/korpholmen.svg').replaceAll('../../icons/korpholmen-180.png','../icons/korpholmen-180.png').replaceAll('../../src/app-family-bootstrap.js','../src/app-family-bootstrap.js');
await writeFile(resolve(OUT,'index.html'),sharedIndex);
for(const relative of CORE_FILES){const source=resolve(CORE,relative);if(!(await stat(source)).isFile())throw new Error(`Gemensam kärnfil saknas: ${relative}`);const target=resolve(OUT,'core',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
for(const relative of MASTER_V2_FILES){const source=resolve(MASTER_V2,relative);if(!(await stat(source)).isFile())throw new Error(`Master V2-fil saknas: ${relative}`);const target=resolve(OUT,'master-data-v2',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const canary=(await readFile(resolve(ROOT,'src/matrikel-canary.js'),'utf8')).replaceAll('../../../packages/core/','../core/');
await writeFile(resolve(OUT,'src/matrikel-canary.js'),canary);
const app=(await readFile(resolve(ROOT,'src/app.js'),'utf8')).replaceAll('../../../packages/core/','../core/');
await mkdir(resolve(OUT,'src'),{recursive:true});await writeFile(resolve(OUT,'src/app.js'),app);
for(const relative of APP_V2_FILES){const sourceText=(await readFile(resolve(ROOT,relative),'utf8')).replaceAll('../../../packages/core/','../core/').replaceAll('../../../packages/master-data-v2/','../master-data-v2/');await writeFile(resolve(OUT,relative),sourceText)}
await assertExactPublicationFiles(OUT,[...FILES,'src/app.js','src/matrikel-canary.js',...APP_V2_FILES,...CORE_FILES.map(file=>`core/${file}`),...MASTER_V2_FILES.map(file=>`master-data-v2/${file}`)]);
const bundle=(await Promise.all([...FILES.map(file=>readFile(resolve(OUT,file),'utf8')),...APP_V2_FILES.map(file=>readFile(resolve(OUT,file),'utf8')),...CORE_FILES.map(file=>readFile(resolve(OUT,'core',file),'utf8')),...MASTER_V2_FILES.map(file=>readFile(resolve(OUT,'master-data-v2',file),'utf8')),Promise.resolve(canary),Promise.resolve(app)])).join('\n');
const privateData=await readOptionalPrivateJson(resolve(ROOT,'privat/migrering-2026-08-02/initial-ops.json'));
const privateValues=(privateData?.operations||[]).filter(operation=>['raw_text','person_name_raw','boat_name_raw','source_line_raw'].includes(operation.field)).map(operation=>String(operation.value||'')).filter(value=>value.length>=7);
if(privateValues.some(value=>bundle.includes(JSON.stringify(value)))||bundle.includes('"operations_version"')||bundle.includes('"person-occurrence:matrikel-'))throw new Error('Privata Klubbhistorik-data har läckt in i publiceringspaketet.');
console.log(`Datafri Klubbhistorik byggd: ${FILES.length+APP_V2_FILES.length+CORE_FILES.length+MASTER_V2_FILES.length+2} filer.`);
