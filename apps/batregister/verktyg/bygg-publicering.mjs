import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles, readOptionalPrivateJson } from '../../../verktyg/publication-guard.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../batregister');
const CORE=resolve(ROOT,'../../packages/core');
const MASTER=resolve(ROOT,'../../packages/master-data-v2');
const FILES=['index.html','styles.css','manifest.webmanifest','sw.js','icons/icon.svg','src/config.js','src/image-pipeline.js','src/boat-master-view.js','src/owner-review.js','src/owner-review-decisions.js','src/spec-review-decisions.js','src/source-review.js'];
const APP_FILES=['src/app.js','src/connection-filter.js','src/batregister-runtime.js','src/batregister-v2-ui.js','src/batregister-writer.js'];
const CORE_FILES=['active-json-master.js','data-layer.js','dependency-compatibility.js','generation-cutover.js','runtime-safety.js','family-context.js','master-data.js','read-only-master.js','domain/canonical.js','domain/hlc.js','domain/materializer.js','domain/operations.js','domain/repository.js','pwa/korpholmen-service-worker.js','storage/indexeddb.js','storage/memory.js','sync/app-family-sync.js','sync/batch.js','sync/batch-progress.js','sync/checkpoint-format.js','sync/dropbox-transport.js','sync/errors.js','sync/http-read-transport.js','sync/memory-transport.js','sync/oauth-flow.js','sync/oauth-pkce.js','sync/shared-dropbox-session.js','sync/sync-engine.js'];
const MASTER_FILES=['index.js','src/domain-contracts.js','src/errors.js','src/family-units.js','src/master.js','src/memory-storage.js','src/repository.js','src/revision-storage.js','src/validation.js'];
for(const relative of FILES){const source=resolve(ROOT,relative);if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const sharedIndex=(await readFile(resolve(ROOT,'index.html'),'utf8')).replaceAll('../../manifest.webmanifest','../manifest.webmanifest').replaceAll('../../icons/korpholmen.svg','../icons/korpholmen.svg').replaceAll('../../icons/korpholmen-180.png','../icons/korpholmen-180.png').replaceAll('../../src/app-family-bootstrap.js','../src/app-family-bootstrap.js');
await writeFile(resolve(OUT,'index.html'),sharedIndex);
for(const relative of CORE_FILES){const source=resolve(CORE,relative);if(!(await stat(source)).isFile())throw new Error(`Gemensam kärnfil saknas: ${relative}`);const target=resolve(OUT,'core',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
for(const relative of MASTER_FILES){const source=resolve(MASTER,relative);if(!(await stat(source)).isFile())throw new Error(`Masterdatakärna saknas: ${relative}`);const target=resolve(OUT,'master-data-v2',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const appSources=[];
for(const relative of APP_FILES){const source=(await readFile(resolve(ROOT,relative),'utf8')).replaceAll('../../../packages/core/','../core/').replaceAll('../../../packages/master-data-v2/','../master-data-v2/');const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await writeFile(target,source);appSources.push(source)}
await assertExactPublicationFiles(OUT,[...FILES,...APP_FILES,...CORE_FILES.map(file=>`core/${file}`),...MASTER_FILES.map(file=>`master-data-v2/${file}`)]);
const bundle=(await Promise.all([...FILES.map(file=>readFile(resolve(OUT,file),'utf8')),...CORE_FILES.map(file=>readFile(resolve(OUT,'core',file),'utf8')),...MASTER_FILES.map(file=>readFile(resolve(OUT,'master-data-v2',file),'utf8')),...appSources.map(async source=>source)])).join('\n');
const privateData=await readOptionalPrivateJson(resolve(ROOT,'privat/migrering-2026-08-01/initial-ops.json'));
const privateBoatNames=(privateData?.operations||[]).filter(operation=>operation.entity_type==='boat'&&operation.field==='namn').map(operation=>operation.value).filter(name=>name&&name!=='Namn okänt');
if(privateBoatNames.some(name=>bundle.includes(JSON.stringify(name)))||bundle.includes('"operations_version"')||bundle.includes('data:image/'))throw new Error('Privat båtdata har läckt in i publiceringspaketet');
console.log(`Datafritt Båtregister byggt: ${FILES.length+APP_FILES.length+CORE_FILES.length+MASTER_FILES.length} filer.`);
