import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../korpholmenrunt');
const CORE=resolve(ROOT,'../../packages/core');
const FILES=['index.html','styles.css','manifest.webmanifest','sw.js','og.png','src/config.js'];
const CORE_FILES=['data-layer.js','domain/canonical.js','domain/hlc.js','domain/materializer.js','domain/operations.js','domain/repository.js','storage/indexeddb.js','storage/memory.js','sync/batch.js','sync/dropbox-transport.js','sync/errors.js','sync/memory-transport.js','sync/oauth-flow.js','sync/oauth-pkce.js','sync/sync-engine.js'];
for(const relative of FILES){const source=resolve(ROOT,relative);if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
for(const relative of CORE_FILES){const source=resolve(CORE,relative);if(!(await stat(source)).isFile())throw new Error(`Gemensam kärnfil saknas: ${relative}`);const target=resolve(OUT,'core',relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const app=(await readFile(resolve(ROOT,'src/app.js'),'utf8')).replace("../../../packages/core/data-layer.js","../core/data-layer.js");
await mkdir(resolve(OUT,'src'),{recursive:true});await writeFile(resolve(OUT,'src/app.js'),app);
const bundle=(await Promise.all([...FILES.filter(file=>!file.endsWith('.png')).map(file=>readFile(resolve(OUT,file),'utf8')),...CORE_FILES.map(file=>readFile(resolve(OUT,'core',file),'utf8')),Promise.resolve(app)])).join('\n');
const privateData=JSON.parse(await readFile(resolve(ROOT,'privat/migrering-2026-08-02/initial-ops.json'),'utf8'));
const privateValues=privateData.operations.filter(operation=>['boat_name_raw','captain_raw','crew_1_raw','crew_2_raw'].includes(operation.field)).map(operation=>String(operation.value||'')).filter(value=>value.length>=4);
if(privateValues.some(value=>bundle.includes(JSON.stringify(value)))||bundle.includes('"operations_version"')||bundle.includes('"raw_row"'))throw new Error('Privata resultatdata har läckt in i publiceringspaketet');
console.log(`Datafritt Korpholmen runt byggt: ${FILES.length+CORE_FILES.length+1} filer.`);
