import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { batchPath, compareHLC, createBatch, createClock, createSetOperation, materialize, validateBatch } from '../../../packages/core/data-layer.js';
import { KLASSSTANDARD_METHOD, standardklass } from '../src/klassstandard.js';

const DEVICE='korpholmenrunt-klassstandard-20260804';
const requestedRoot=process.argv[2];
const dryRun=process.argv.includes('--dry-run');
if(!requestedRoot)throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
const opsRoot=resolve(dropboxRoot,'korpholmenrunt/ops');
const files=(await readdir(opsRoot)).filter(file=>file.endsWith('.json')).sort();
const batches=await Promise.all(files.map(async file=>{const batch=JSON.parse(await readFile(resolve(opsRoot,file),'utf8'));validateBatch(batch);return batch}));
const existingOps=batches.flatMap(batch=>batch.ops);
const state=materialize(existingOps);
const results=state.listEntities('race-result').map(entity=>({id:entity.entity_id,...entity.fields}));
const currentDeviceSeq=existingOps.filter(operation=>operation.device_id===DEVICE).reduce((max,operation)=>Math.max(max,operation.seq),0);
const latestHlc=existingOps.map(operation=>operation.hlc).reduce((latest,value)=>!latest||compareHLC(value,latest)>0?value:latest,null);

const manualOverride=(result,rawClass)=>{if(result.class_match_status!=='manuell'||!result.class_match_method||result.class_match_method===KLASSSTANDARD_METHOD)return false;const selected=standardklass(result.class_name);return !selected||selected.id!==rawClass.id};
const plans=[];const unknown=[];let overrides=0;
for(const result of results){
  const klass=standardklass(result.class_raw);
  if(!klass){unknown.push(String(result.class_raw||''));continue}
  if(manualOverride(result,klass)){overrides+=1;continue}
  const expected={class_id:klass.id,class_name:klass.name,class_match_status:'manuell',class_match_method:KLASSSTANDARD_METHOD};
  const entries=Object.entries(expected).filter(([field,value])=>result[field]!==value).map(([field,value])=>({entityType:'race-result',entityId:result.id,field,value}));
  if(entries.length)plans.push({resultId:result.id,entries});
}

const clock=createClock(DEVICE,()=>Date.now(),latestHlc);let seq=currentDeviceSeq;
const operations=plans.flatMap(plan=>plan.entries.map(entry=>createSetOperation({deviceId:DEVICE,seq:++seq,entityType:entry.entityType,entityId:entry.entityId,field:entry.field,value:entry.value,hlc:clock.tick()})));
const counters={batches_written:0,batches_identical:0};
async function writeImmutableBatch(batch){
  const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/korpholmenrunt/ops').replace(/^\/korpholmenrunt\/ops\//,'');
  const path=resolve(opsRoot,relative);const content=`${JSON.stringify(batch,null,2)}\n`;
  await mkdir(opsRoot,{recursive:true});
  try{await writeFile(path,content,{flag:'wx'});counters.batches_written+=1}catch(error){if(error.code!=='EEXIST')throw error;const existing=await readFile(path,'utf8');if(existing!==content)throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`);counters.batches_identical+=1}
}
if(!dryRun)for(let index=0;index<operations.length;index+=250)await writeImmutableBatch(createBatch(operations.slice(index,index+250)));

const after=materialize([...existingOps,...operations]);
const remaining=after.listEntities('race-result').map(entity=>entity.fields).filter(result=>{const klass=standardklass(result.class_raw);return klass&&!manualOverride(result,klass)&&(result.class_id!==klass.id||result.class_name!==klass.name||result.class_match_method!==KLASSSTANDARD_METHOD)});
if(remaining.length)throw new Error(`${remaining.length} resultat blev inte fullständigt standardiserade`);
console.log(JSON.stringify({target:opsRoot,dry_run:dryRun,results:results.length,results_planned:plans.length,operations:operations.length,manual_overrides_preserved:overrides,unknown_raw_classes:[...new Set(unknown)].sort(),...counters},null,2));
