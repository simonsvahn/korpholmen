import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat/aktuell-startmaster');
const requestedRoot=process.argv[2];
if(!requestedRoot)throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');

const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

const document=JSON.parse(await readFile(resolve(PRIVATE,'initial-ops.json'),'utf8'));
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

for(let index=0;index<document.operations.length;index+=250){
  const batch=createBatch(document.operations.slice(index,index+250));
  const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/dokumentarkiv/ops').replace(/^\//,'');
  await writeImmutableJson(resolve(dropboxRoot,relative),batch);
}

const state=materialize(document.operations);
console.log(JSON.stringify({
  target:dropboxRoot,
  operations:document.operations.length,
  documents:state.listEntities('document').length,
  archive_entities:state.listEntities('archive-entity').length,
  ...counters,
},null,2));
