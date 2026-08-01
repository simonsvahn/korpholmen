import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'../../batregister');
const FILES=['index.html','styles.css','manifest.webmanifest','sw.js','icons/icon.svg','src/config.js'];
for(const relative of FILES){const source=resolve(ROOT,relative);if(!(await stat(source)).isFile())throw new Error(`Publiceringsfil saknas: ${relative}`);const target=resolve(OUT,relative);await mkdir(dirname(target),{recursive:true});await copyFile(source,target)}
const app=(await readFile(resolve(ROOT,'src/app.js'),'utf8')).replace("../../../packages/core/data-layer.js","../../packages/core/data-layer.js");
await mkdir(resolve(OUT,'src'),{recursive:true});await writeFile(resolve(OUT,'src/app.js'),app);
const bundle=(await Promise.all([...FILES.map(file=>readFile(resolve(OUT,file),'utf8')),(async()=>app)()])).join('\n');
const privateData=JSON.parse(await readFile(resolve(ROOT,'privat/migrering-2026-08-01/initial-ops.json'),'utf8'));
const privateBoatNames=privateData.operations.filter(operation=>operation.entity_type==='boat'&&operation.field==='namn').map(operation=>operation.value).filter(name=>name&&name!=='Namn okänt');
if(privateBoatNames.some(name=>bundle.includes(JSON.stringify(name)))||bundle.includes('"operations_version"')||bundle.includes('data:image/'))throw new Error('Privat båtdata har läckt in i publiceringspaketet');
console.log(`Datafritt Båtregister byggt: ${FILES.length+1} filer.`);
