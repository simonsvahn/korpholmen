import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  batchPath,
  compareHLC,
  createBatch,
  createClock,
  createSetOperation,
  materialize,
  validateBatch,
} from '../../../packages/core/data-layer.js';

const run=promisify(execFile);
const DEVICE='korpholmenrunt-kallbilder-20260806';
const requestedDropboxRoot=process.argv[2];
const requestedSourceRoot=process.argv[3];
const write=process.argv.includes('--write');
if(!requestedDropboxRoot||!requestedSourceRoot)throw new Error('Ange Dropbox-roten och roten 01 Digitaliserade dokument');
const dropboxRoot=await realpath(resolve(requestedDropboxRoot));
const sourceRoot=await realpath(resolve(requestedSourceRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
if(!sourceRoot.includes('/Digitalisering 2026/01 Digitaliserade dokument'))throw new Error(`Avbryter: källroten är oväntad: ${sourceRoot}`);

const opsRoot=resolve(dropboxRoot,'korpholmenrunt/ops');
const imageRoot=resolve(dropboxRoot,'korpholmenrunt/kallbilder');
const batchFiles=(await readdir(opsRoot)).filter(file=>file.endsWith('.json')).sort();
const batches=await Promise.all(batchFiles.map(async file=>{const batch=JSON.parse(await readFile(resolve(opsRoot,file),'utf8'));validateBatch(batch);return batch}));
const existingOps=batches.flatMap(batch=>batch.ops);
const state=materialize(existingOps);
const sources=state.listEntities('race-source').map(entity=>({id:entity.entity_id,...entity.fields})).filter(source=>source.sha256&&source.private_copy&&/\.(?:heic|jpe?g|png)$/iu.test(source.private_copy)).sort((a,b)=>a.id.localeCompare(b.id,'sv'));
if(!sources.length)throw new Error('Inga analoga bildkällor hittades i den levande mastern');

const fileKey=value=>String(value).normalize('NFC').toLocaleLowerCase('sv');
const wantedNames=new Set(sources.map(source=>fileKey(basename(source.private_copy))));
const candidatesByName=new Map();
async function indexSources(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())await indexSources(path);else if(wantedNames.has(fileKey(entry.name))){const key=fileKey(entry.name);if(!candidatesByName.has(key))candidatesByName.set(key,[]);candidatesByName.get(key).push(path)}}}
await indexSources(sourceRoot);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function existingFile(path){try{return (await stat(path)).isFile()}catch{return false}}
async function locateOriginal(source){const paths=[];if(isAbsolute(String(source.original_path||''))&&await existingFile(source.original_path))paths.push(source.original_path);paths.push(...(candidatesByName.get(fileKey(basename(source.private_copy)))||[]));for(const path of [...new Set(paths)]){const bytes=await readFile(path);if(sha256(bytes)===source.sha256)return {path,bytes}}throw new Error(`Original med rätt kontrollsumma saknas för ${source.id} (${source.private_copy})`)}

const temporary=await mkdtemp(resolve(tmpdir(),'korpholmenrunt-kallbilder-'));
const prepared=[];
try{
  for(const source of sources){
    const original=await locateOriginal(source);const blobPath=`/korpholmenrunt/kallbilder/${source.sha256}.jpg`;const localBlobPath=resolve(imageRoot,`${source.sha256}.jpg`);let jpegBytes;
    if(await existingFile(localBlobPath))jpegBytes=await readFile(localBlobPath);else{const output=resolve(temporary,`${source.sha256}.jpg`);await run('sips',['-s','format','jpeg','-s','formatOptions','90','-Z','3200',original.path,'--out',output]);jpegBytes=await readFile(output)}
    const imageHash=sha256(jpegBytes);const displayImage={blob_path:blobPath,sha256:imageHash,mime_type:'image/jpeg',filename:`${source.label||basename(source.private_copy,extname(source.private_copy))} – läskopia.jpg`,original_filename:basename(original.path),original_sha256:source.sha256,kind:'icke-generativ läskopia'};
    prepared.push({source,originalPath:original.path,localBlobPath,jpegBytes,displayImage});
  }
}finally{await rm(temporary,{recursive:true,force:true})}

const latestHlc=existingOps.map(operation=>operation.hlc).reduce((latest,value)=>!latest||compareHLC(value,latest)>0?value:latest,null);
const currentSeq=existingOps.filter(operation=>operation.device_id===DEVICE).reduce((maximum,operation)=>Math.max(maximum,operation.seq),0);
const clock=createClock(DEVICE,()=>Date.now(),latestHlc);let seq=currentSeq;
const operations=prepared.filter(item=>JSON.stringify(item.source.display_image)!==JSON.stringify(item.displayImage)).map(item=>createSetOperation({deviceId:DEVICE,seq:++seq,entityType:'race-source',entityId:item.source.id,field:'display_image',value:item.displayImage,hlc:clock.tick()}));
const writtenImages=[];const writtenBatches=[];
async function writeImmutable(path,bytes){await mkdir(resolve(path,'..'),{recursive:true});try{await writeFile(path,bytes,{flag:'wx'});return true}catch(error){if(error.code!=='EEXIST')throw error;const existing=await readFile(path);if(!existing.equals(bytes))throw new Error(`Befintlig fil skiljer sig och skrivs inte över: ${path}`);return false}}
if(write){
  for(const item of prepared)if(await writeImmutable(item.localBlobPath,item.jpegBytes))writtenImages.push(item.localBlobPath);
  for(let index=0;index<operations.length;index+=250){const batch=createBatch(operations.slice(index,index+250));const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/korpholmenrunt/ops').replace(/^\/korpholmenrunt\/ops\//,'');const path=resolve(opsRoot,relative);if(await writeImmutable(path,Buffer.from(`${JSON.stringify(batch,null,2)}\n`)))writtenBatches.push(path)}
}

const after=materialize([...existingOps,...operations]);
for(const item of prepared){const actual=after.getEntity('race-source',item.source.id)?.fields.display_image;if(JSON.stringify(actual)!==JSON.stringify(item.displayImage))throw new Error(`Bildmetadata kunde inte verifieras för ${item.source.id}`)}
console.log(JSON.stringify({dry_run:!write,sources:prepared.length,operations:operations.length,images_written:writtenImages,batches_written:writtenBatches,items:prepared.map(item=>({source_id:item.source.id,original:item.originalPath,blob_path:item.displayImage.blob_path,sha256:item.displayImage.sha256}))},null,2));
