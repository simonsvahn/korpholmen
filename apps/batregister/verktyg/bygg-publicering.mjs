import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles, readOptionalPrivateJson } from '../../../verktyg/publication-guard.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../batregister');
const CORE=resolve(ROOT,'../../packages/core');
const FILES=['index.html','styles.css','manifest.webmanifest','sw.js','icons/icon.svg','src/config.js'];
const CORE_FILES=['data-layer.js', 'runtime-safety.js', 'family-context.js','master-data.js','read-only-master.js','domain/canonical.js','domain/hlc.js','domain/materializer.js','domain/operations.js','domain/repository.js','pwa/korpholmen-service-worker.js','storage/indexeddb.js','storage/memory.js','sync/app-family-sync.js','sync/batch.js','sync/checkpoint-format.js','sync/dropbox-transport.js','sync/errors.js','sync/memory-transport.js','sync/oauth-flow.js','sync/oauth-pkce.js','sync/shared-dropbox-session.js','sync/sync-engine.js'];
for(const relative of FILES){const source=resolve(ROOT,relative);if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const sharedIndex=(await readFile(resolve(ROOT,'index.html'),'utf8')).replaceAll('../../manifest.webmanifest','../manifest.webmanifest').replaceAll('../../icons/korpholmen.svg','../icons/korpholmen.svg').replaceAll('../../icons/korpholmen-180.png','../icons/korpholmen-180.png').replaceAll('../../src/app-family-bootstrap.js','../src/app-family-bootstrap.js');
await writeFile(resolve(OUT,'index.html'),sharedIndex);
for(const relative of CORE_FILES){const source=resolve(CORE,relative);if(!(await stat(source)).isFile())throw new Error(`Gemensam kärnfil saknas: ${relative}`);const target=resolve(OUT,'core',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const app=(await readFile(resolve(ROOT,'src/app.js'),'utf8')).replaceAll('../../../packages/core/','../core/');
await mkdir(resolve(OUT,'src'),{recursive:true});await writeFile(resolve(OUT,'src/app.js'),app);
const connectionFilter=(await readFile(resolve(ROOT,'src/connection-filter.js'),'utf8')).replace("../../../packages/core/family-context.js","../core/family-context.js");
await writeFile(resolve(OUT,'src/connection-filter.js'),connectionFilter);
await assertExactPublicationFiles(OUT,[...FILES,'src/app.js','src/connection-filter.js',...CORE_FILES.map(file=>`core/${file}`)]);
const bundle=(await Promise.all([...FILES.map(file=>readFile(resolve(OUT,file),'utf8')),...CORE_FILES.map(file=>readFile(resolve(OUT,'core',file),'utf8')),(async()=>app)(),(async()=>connectionFilter)()])).join('\n');
const privateData=await readOptionalPrivateJson(resolve(ROOT,'privat/migrering-2026-08-01/initial-ops.json'));
const privateBoatNames=(privateData?.operations||[]).filter(operation=>operation.entity_type==='boat'&&operation.field==='namn').map(operation=>operation.value).filter(name=>name&&name!=='Namn okänt');
if(privateBoatNames.some(name=>bundle.includes(JSON.stringify(name)))||bundle.includes('"operations_version"')||bundle.includes('data:image/'))throw new Error('Privat båtdata har läckt in i publiceringspaketet');
console.log(`Datafritt Båtregister byggt: ${FILES.length+CORE_FILES.length+2} filer.`);
