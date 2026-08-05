import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  batchPath,
  canonicalStringify,
  compareHLC,
  createBatch,
  createClock,
  createDeleteOperation,
  createSetOperation,
  materialize,
  validateBatch,
} from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const DEFAULT_OPS_ROOT='/Users/simon/Dropbox/Appar/Korpholmen/korpholmenrunt/ops';
const OPS_ROOT=process.env.KORPHOLMENRUNT_OPS_ROOT||DEFAULT_OPS_ROOT;
const DEVICE='korpholmenrunt-strukturera-med-flera-20260804';
const PLACEHOLDER_ID='race-participant-placeholder:med-flera';
const WRITE=process.env.MED_FLERA_SKRIV==='1';
const MED_FLERA_RE=/^(.*?)\s*(?:m\s*\.?\s*fl\.?|med\s+flera)\s*$/iu;

const files=(await readdir(OPS_ROOT)).filter(file=>file.endsWith('.json')).sort();
const batches=await Promise.all(files.map(async file=>{
  const batch=JSON.parse(await readFile(resolve(OPS_ROOT,file),'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOps=batches.flatMap(batch=>batch.ops);
const before=materialize(existingOps);
const list=type=>before.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const results=list('race-result');
const links=list('race-person-link');
const resultById=new Map(results.map(result=>[result.id,result]));
const linksByResult=new Map();
for(const link of links){if(!linksByResult.has(link.result_id))linksByResult.set(link.result_id,[]);linksByResult.get(link.result_id).push(link)}
const sourceOrder=link=>Number.isInteger(link.participant_order)?link.participant_order:({kapten:0,'besattning-1':100,'besattning-2':200}[link.source_parent_field||link.source_field]??900);
const targets=links.filter(link=>link.participant_kind!=='placeholder'&&MED_FLERA_RE.test(String(link.raw_name||'').trim()));

const latestHlc=existingOps.map(operation=>operation.hlc).reduce((latest,value)=>!latest||compareHLC(value,latest)>0?value:latest,null);
const currentSeq=existingOps.filter(operation=>operation.device_id===DEVICE).reduce((maximum,operation)=>Math.max(maximum,operation.seq),0);
const clock=createClock(DEVICE,()=>Date.now(),latestHlc);
let seq=currentSeq;
const operations=[];
const overlays=new Map();
const same=(left,right)=>left===undefined||right===undefined?left===right:canonicalStringify(left)===canonicalStringify(right);
const set=(entityType,entityId,field,value)=>{
  const key=`${entityType}\u0000${entityId}\u0000${field}`;
  const current=overlays.has(key)?overlays.get(key):before.getEntity(entityType,entityId)?.fields?.[field];
  if(same(current,value))return false;
  operations.push(createSetOperation({deviceId:DEVICE,seq:++seq,entityType,entityId,field,value,hlc:clock.tick()}));
  overlays.set(key,structuredClone(value));
  return true;
};
const del=(entityType,entityId)=>operations.push(createDeleteOperation({deviceId:DEVICE,seq:++seq,entityType,entityId,hlc:clock.tick()}));

for(const [field,value] of Object.entries({
  code:'med-flera',
  label:'Med flera',
  kind:'okända ytterligare tävlande',
  terminal:true,
  review_status:'avslutad',
  description:'Källan anger ytterligare tävlande vars identiteter inte kan fastställas och inte ska ligga kvar som granskningsfråga.',
}))set('race-participant-placeholder',PLACEHOLDER_ID,field,value);

const migrated=[];
for(const link of targets){
  const sourceRaw=String(link.source_raw_name||link.raw_name).trim();
  const match=String(link.raw_name).trim().match(MED_FLERA_RE);
  const named=match?.[1]?.trim()||'';
  const result=resultById.get(link.result_id);
  if(!result)throw new Error(`Resultat saknas för ${link.id}`);
  const current=[...(linksByResult.get(result.id)||[])].sort((a,b)=>sourceOrder(a)-sourceOrder(b)||a.id.localeCompare(b.id,'sv'));
  const position=current.findIndex(item=>item.id===link.id);
  if(position<0)throw new Error(`Deltagarlänken saknas i resultatet: ${link.id}`);

  if(!named){
    for(const [field,value] of Object.entries({
      role:`Tävlande ${position+1}`,
      participant_order:position,
      raw_name:'Med flera',
      source_raw_name:sourceRaw,
      participant_kind:'placeholder',
      person_id:null,
      placeholder_id:PLACEHOLDER_ID,
      match_status:'strukturerad-placeholder',
      match_method:'strukturerad platshållare beslutad av Simon 2026-08-04',
      candidate_ids:[],
      confirmed:true,
    }))set('race-person-link',link.id,field,value);
    set('race-result',result.id,'participant_structure_status','strukturerad platshållare');
    set('race-result',result.id,'participant_structure_updated_at','2026-08-04');
    migrated.push({result_id:result.id,source:sourceRaw,links:[link.id]});
    continue;
  }

  const parentField=link.source_parent_field||link.source_field;
  const personLinkId=`${link.id}-del-person`;
  const placeholderLinkId=`${link.id}-del-med-flera`;
  const personFields={
    result_id:result.id,
    role:`Tävlande ${position+1}`,
    source_field:`${parentField}-del-person-med-flera`,
    source_parent_field:parentField,
    participant_order:position,
    raw_name:named,
    source_raw_name:sourceRaw,
    split_from_link_id:link.id,
    split_root_link_id:link.split_root_link_id||link.id,
    participant_kind:'person',
    person_id:null,
    placeholder_id:null,
    match_status:(link.candidate_ids||[]).length?'föreslagen':'saknas',
    match_method:'namngiven del av ett strukturerat med-flera-fält',
    candidate_ids:link.candidate_ids||[],
    confirmed:false,
  };
  const placeholderFields={
    result_id:result.id,
    role:`Tävlande ${position+2}`,
    source_field:`${parentField}-del-med-flera`,
    source_parent_field:parentField,
    participant_order:position+1,
    raw_name:'Med flera',
    source_raw_name:sourceRaw,
    split_from_link_id:link.id,
    split_root_link_id:link.split_root_link_id||link.id,
    participant_kind:'placeholder',
    person_id:null,
    placeholder_id:PLACEHOLDER_ID,
    match_status:'strukturerad-placeholder',
    match_method:'strukturerad platshållare beslutad av Simon 2026-08-04',
    candidate_ids:[],
    confirmed:true,
  };
  for(const [field,value] of Object.entries(personFields))set('race-person-link',personLinkId,field,value);
  for(const [field,value] of Object.entries(placeholderFields))set('race-person-link',placeholderLinkId,field,value);
  const finalIds=current.flatMap(item=>item.id===link.id?[personLinkId,placeholderLinkId]:[item.id]);
  finalIds.forEach((id,index)=>{
    set('race-person-link',id,'participant_order',index);
    set('race-person-link',id,'role',`Tävlande ${index+1}`);
  });
  set('race-result',result.id,'person_link_ids',finalIds);
  set('race-result',result.id,'participant_structure_status','strukturerad platshållare');
  set('race-result',result.id,'participant_structure_updated_at','2026-08-04');
  del('race-person-link',link.id);
  migrated.push({result_id:result.id,source:sourceRaw,links:[personLinkId,placeholderLinkId]});
}

const written=[];
if(WRITE&&operations.length){
  for(let index=0;index<operations.length;index+=250){
    const batch=createBatch(operations.slice(index,index+250));
    const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/korpholmenrunt/ops').replace(/^\/korpholmenrunt\/ops\//,'');
    const path=resolve(OPS_ROOT,relative);
    await mkdir(OPS_ROOT,{recursive:true});
    await writeFile(path,`${JSON.stringify(batch,null,2)}\n`,{flag:'wx'});
    written.push(path);
  }
}

const after=materialize([...existingOps,...(WRITE?operations:[])]);
if(WRITE){
  const placeholders=after.listEntities('race-person-link').map(entity=>({id:entity.entity_id,...entity.fields})).filter(item=>item.placeholder_id===PLACEHOLDER_ID);
  if(placeholders.length!==9||placeholders.some(item=>item.participant_kind!=='placeholder'||item.confirmed!==true||item.match_status!=='strukturerad-placeholder'))throw new Error('Platshållarna verifierades inte efter skrivning');
  const stillOpen=after.listEntities('race-person-link').map(entity=>({id:entity.entity_id,...entity.fields})).filter(item=>!item.confirmed&&MED_FLERA_RE.test(String(item.raw_name||'').trim()));
  if(stillOpen.length)throw new Error(`${stillOpen.length} med-flera-fält ligger fortfarande i granskningskön`);
}

console.log(JSON.stringify({dry_run:!WRITE,targets:targets.length,migrated,operations:operations.length,batches_written:written,ops_root:OPS_ROOT,script_root:ROOT},null,2));
