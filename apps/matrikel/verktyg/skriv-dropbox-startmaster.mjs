import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch, materialize } from '../../../packages/core/data-layer.js';
import { buildCheckpointForApp } from '../../../verktyg/sync-checkpoint-builder.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-02');
const CORRECTIONS=resolve(ROOT,'privat/korrigeringar');
const requestedRoot=process.argv[2];
if(!requestedRoot)throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');

const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

const document=JSON.parse(await readFile(resolve(PRIVATE,'initial-ops.json'),'utf8'));
async function readCorrectionOperations(){
  let files;
  try{files=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')).sort()}
  catch(error){if(error.code==='ENOENT')return [];throw error}
  const documents=await Promise.all(files.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
  return documents.flatMap(item=>item.operations||item.ops||[]);
}
const correctionOperations=await readCorrectionOperations();
const allOperations=[...document.operations,...correctionOperations];
const counters={batches_written:0,batches_identical:0};

async function writeImmutableJson(path,value){
  const content=`${JSON.stringify(value,null,2)}\n`;
  await mkdir(dirname(path),{recursive:true});
  try{
    await writeFile(path,content,{flag:'wx'});
    counters.batches_written+=1;
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=await readFile(path,'utf8');
    if(existing!==content)throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`);
    counters.batches_identical+=1;
  }
}

const byDevice=new Map();
for(const operation of allOperations){
  if(!byDevice.has(operation.device_id))byDevice.set(operation.device_id,[]);
  byDevice.get(operation.device_id).push(operation);
}
for(const deviceOperations of byDevice.values()){
  deviceOperations.sort((a,b)=>a.seq-b.seq);
  for(let index=0;index<deviceOperations.length;index+=250){
    const batch=createBatch(deviceOperations.slice(index,index+250));
    const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/klubbhistorik/ops').replace(/^\//,'');
    await writeImmutableJson(resolve(dropboxRoot,relative),batch);
  }
}

const state=materialize(allOperations);
const checkpoint=await buildCheckpointForApp({
  outputRoot:dropboxRoot,
  app:{id:'klubbhistorik',folder:'klubbhistorik',opsRoot:'/klubbhistorik/ops'},
});
console.log(JSON.stringify({
  target:dropboxRoot,
  base_operations:document.operations.length,
  correction_operations:correctionOperations.length,
  operations:allOperations.length,
  releases:state.listEntities('matrikel-release').length,
  person_occurrences:state.listEntities('person-occurrence').length,
  boat_occurrences:state.listEntities('boat-occurrence').length,
  checkpoint_bytes:checkpoint.manifest.compressed_bytes,
  checkpoint_operations:checkpoint.manifest.source_operation_count,
  ...counters,
},null,2));
