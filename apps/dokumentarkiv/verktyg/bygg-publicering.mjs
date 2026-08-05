import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles } from '../../../verktyg/publication-guard.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../dokumentarkiv');
const CORE=resolve(ROOT,'../../packages/core');
const FILES=['index.html','styles.css','manifest.webmanifest','sw.js','og.png','src/config.js'];
const CORE_FILES=['data-layer.js', 'runtime-safety.js', 'master-data.js','read-only-master.js','domain/canonical.js','domain/hlc.js','domain/materializer.js','domain/operations.js','domain/repository.js','pwa/korpholmen-service-worker.js','storage/indexeddb.js','storage/memory.js','sync/app-family-sync.js','sync/batch.js','sync/dropbox-transport.js','sync/errors.js','sync/memory-transport.js','sync/oauth-flow.js','sync/oauth-pkce.js','sync/shared-dropbox-session.js','sync/sync-engine.js'];

for(const relative of FILES){
  const source=resolve(ROOT,relative);
  if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);
  const target=resolve(OUT,relative);
  await mkdir(dirname(target),{recursive:true});
  await copyFile(source,target);
}
const sharedIndex=(await readFile(resolve(ROOT,'index.html'),'utf8')).replaceAll('../../manifest.webmanifest','../manifest.webmanifest').replaceAll('../../icons/korpholmen.svg','../icons/korpholmen.svg').replaceAll('../../icons/korpholmen-180.png','../icons/korpholmen-180.png').replaceAll('../../src/app-family-bootstrap.js','../src/app-family-bootstrap.js');
await writeFile(resolve(OUT,'index.html'),sharedIndex);
for(const relative of CORE_FILES){
  const source=resolve(CORE,relative);
  if(!(await stat(source)).isFile())throw new Error(`Gemensam kärnfil saknas: ${relative}`);
  const target=resolve(OUT,'core',relative);
  await mkdir(dirname(target),{recursive:true});
  await copyFile(source,target);
}

const app=(await readFile(resolve(ROOT,'src/app.js'),'utf8')).replaceAll('../../../packages/core/','../core/');
await mkdir(resolve(OUT,'src'),{recursive:true});
await writeFile(resolve(OUT,'src/app.js'),app);
await assertExactPublicationFiles(OUT,[...FILES,'src/app.js',...CORE_FILES.map(file=>`core/${file}`)]);

const bundle=(await Promise.all([
  ...FILES.filter(file=>!file.endsWith('.png')).map(file=>readFile(resolve(OUT,file),'utf8')),
  ...CORE_FILES.map(file=>readFile(resolve(OUT,'core',file),'utf8')),
  Promise.resolve(app),
])).join('\n');
const privateData=JSON.parse(await readFile(resolve(ROOT,'privat/aktuell-startmaster/initial-ops.json'),'utf8'));
const privateTitles=privateData.operations.filter(operation=>operation.entity_type==='document'&&operation.field==='title').map(operation=>operation.value).filter(Boolean);
if(privateTitles.some(title=>bundle.includes(String(title)))||bundle.includes('"operations_version"')||bundle.includes('"transcript"'))throw new Error('Privata avskrifter har läckt in i publiceringspaketet');

console.log(`Datafritt Dokumentarkiv byggt: ${FILES.length+CORE_FILES.length+1} filer.`);
