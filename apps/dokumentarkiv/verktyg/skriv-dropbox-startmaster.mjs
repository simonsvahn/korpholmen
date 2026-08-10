import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
const imageDocument=JSON.parse(await readFile(resolve(PRIVATE,'innehållsbilder.json'),'utf8'));
const archiveDocument=JSON.parse(await readFile(resolve(PRIVATE,'källfiler.json'),'utf8'));
if(imageDocument.version!==1||!Array.isArray(imageDocument.images))throw new Error('Manifestet för innehållsbilder har fel format');
if(archiveDocument.version!==1||!Array.isArray(archiveDocument.files))throw new Error('Manifestet för källfiler har fel format');
const counters={batches_written:0,batches_identical:0,images_written:0,images_identical:0,source_files_written:0,source_files_identical:0};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

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

async function writeImmutableImage(image){
  if(!/^\/dokumentarkiv\/bilder\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(image.blob_path)||image.blob_path.includes('..'))throw new Error(`Ogiltig bildväg: ${image.blob_path}`);
  const source=await realpath(image.source_file);
  const sourceBytes=await readFile(source);
  if(sha256(sourceBytes)!==image.sha256)throw new Error(`Innehållsbildens hash stämmer inte: ${source}`);
  const target=resolve(dropboxRoot,image.blob_path.replace(/^\//,''));
  await mkdir(dirname(target),{recursive:true});
  try{
    await copyFile(source,target,constants.COPYFILE_EXCL);
    const written=await readFile(target);
    if(sha256(written)!==image.sha256)throw new Error(`Kopierad innehållsbild fick fel hash: ${target}`);
    counters.images_written+=1;
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=await readFile(target);
    if(sha256(existing)!==image.sha256)throw new Error(`Befintlig innehållsbild skiljer sig och skrivs inte över: ${target}`);
    counters.images_identical+=1;
  }
}

async function writeImmutableSourceFile(file){
  if(!/^\/dokumentarkiv\/kallor\/(?:original|laskopior)\/[a-f0-9]{64}\.(?:heic|heif|jpg|png|pdf)$/.test(file.blob_path)||file.blob_path.includes('..'))throw new Error(`Ogiltig källfilsväg: ${file.blob_path}`);
  const source=await realpath(file.source_file);
  const sourceBytes=await readFile(source);
  if(sha256(sourceBytes)!==file.sha256)throw new Error(`Källfilens hash stämmer inte: ${source}`);
  const target=resolve(dropboxRoot,file.blob_path.replace(/^\//,''));
  await mkdir(dirname(target),{recursive:true});
  try{
    await copyFile(source,target,constants.COPYFILE_EXCL);
    const written=await readFile(target);
    if(sha256(written)!==file.sha256)throw new Error(`Kopierad källfil fick fel hash: ${target}`);
    counters.source_files_written+=1;
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=await readFile(target);
    if(sha256(existing)!==file.sha256)throw new Error(`Befintlig källfil skiljer sig och skrivs inte över: ${target}`);
    counters.source_files_identical+=1;
  }
}

for(let index=0;index<document.operations.length;index+=250){
  const batch=createBatch(document.operations.slice(index,index+250));
  const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/dokumentarkiv/ops').replace(/^\//,'');
  await writeImmutableJson(resolve(dropboxRoot,relative),batch);
}
for(const image of imageDocument.images)await writeImmutableImage(image);
for(const file of archiveDocument.files)await writeImmutableSourceFile(file);

const state=materialize(document.operations);
console.log(JSON.stringify({
  target:dropboxRoot,
  operations:document.operations.length,
  documents:state.listEntities('document').length,
  archive_entities:state.listEntities('archive-entity').length,
  content_images:imageDocument.images.length,
  source_files:archiveDocument.files.length,
  ...counters,
},null,2));
