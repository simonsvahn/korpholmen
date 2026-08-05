import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  batchPath,
  canonicalStringify,
  compareHLC,
  createBatch,
  createClock,
  createSetOperation,
  materialize,
  validateBatch,
} from '../../../packages/core/data-layer.js';
import { createResetOperation } from '../../../packages/core/domain/operations.js';

const DEVICE='korpholmenrunt-tavlande-v3-20260805';
const requestedRoot=process.argv.find(value=>value.endsWith('Korpholmen'))||'/Users/simon/Dropbox/Appar/Korpholmen';
const write=process.argv.includes('--write');
const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
const opsRoot=resolve(dropboxRoot,'korpholmenrunt/ops');
const files=(await readdir(opsRoot)).filter(file=>file.endsWith('.json')).sort();
const batches=await Promise.all(files.map(async file=>{
  const batch=JSON.parse(await readFile(resolve(opsRoot,file),'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOps=batches.flatMap(batch=>batch.ops);
const before=materialize(existingOps);
const list=type=>before.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const results=list('race-result');
const links=list('race-person-link');
const roots=list('race-root');
const linksByResult=new Map();
for(const link of links){if(!linksByResult.has(link.result_id))linksByResult.set(link.result_id,[]);linksByResult.get(link.result_id).push(link)}

const participantGroup=link=>{
  if(Number.isInteger(link.participant_group))return link.participant_group;
  const source=String(link.source_parent_field||link.source_field||'');
  if(source.startsWith('kapten'))return 0;
  if(source.startsWith('besattning-1'))return 1;
  if(source.startsWith('besattning-2'))return 2;
  return Math.max(0,Math.min(2,Math.floor((Number(link.participant_order)||0)/100)));
};
const participantOrder=link=>Number.isInteger(link.participant_order)?link.participant_order:participantGroup(link)*100;
const transformedLinks=links.map(link=>{
  const {id,source_field:_sourceField,source_parent_field:_sourceParentField,...fields}=link;
  return {id,fields:{...fields,role:'tävlande',participant_group:participantGroup(link),participant_order:participantOrder(link)}};
});
const transformedLinkById=new Map(transformedLinks.map(link=>[link.id,link.fields]));
const transformedResults=results.map(result=>{
  const {id,captain_raw:_captain,crew_1_raw:_crew1,crew_2_raw:_crew2,person_link_ids:_personLinkIds,...fields}=result;
  const resultLinks=[...(linksByResult.get(id)||[])].sort((a,b)=>participantOrder(a)-participantOrder(b)||a.id.localeCompare(b.id,'sv'));
  const participantsRaw=Array.isArray(result.participants_raw)?result.participants_raw:[result.captain_raw||'',result.crew_1_raw||'',result.crew_2_raw||''];
  return {id,fields:{...fields,participants_raw:participantsRaw,participant_link_ids:resultLinks.map(link=>link.id)}};
});
const transformedRoots=roots.map(root=>{const {id,...fields}=root;return{id,fields:{...fields,schema_version:3,participant_model:'tävlande',migration_id:'korpholmenrunt-2026-08-05-v3-tavlande'}}});
const alreadyV3=roots.every(root=>root.schema_version===3&&root.participant_model==='tävlande')
  &&results.every(result=>Array.isArray(result.participants_raw)&&Array.isArray(result.participant_link_ids)&&!['captain_raw','crew_1_raw','crew_2_raw','person_link_ids'].some(field=>Object.hasOwn(result,field)))
  &&links.every(link=>link.role==='tävlande'&&Number.isInteger(link.participant_group)&&Number.isInteger(link.participant_order)&&!['source_field','source_parent_field'].some(field=>Object.hasOwn(link,field)));

const currentDeviceSeq=existingOps.filter(operation=>operation.device_id===DEVICE).reduce((max,operation)=>Math.max(max,operation.seq),0);
const latestHlc=existingOps.map(operation=>operation.hlc).reduce((latest,value)=>!latest||compareHLC(value,latest)>0?value:latest,null);
const clock=createClock(DEVICE,()=>Date.now(),latestHlc);
let seq=currentDeviceSeq;
const operations=[];
function replaceEntity(entityType,entityId,fields){
  operations.push(createResetOperation({deviceId:DEVICE,seq:++seq,entityType,entityId,hlc:clock.tick()}));
  for(const field of Object.keys(fields).sort())operations.push(createSetOperation({deviceId:DEVICE,seq:++seq,entityType,entityId,field,value:fields[field],hlc:clock.tick()}));
}
if(!alreadyV3){
  for(const result of transformedResults)replaceEntity('race-result',result.id,result.fields);
  for(const link of transformedLinks)replaceEntity('race-person-link',link.id,link.fields);
  for(const root of transformedRoots)replaceEntity('race-root',root.id,root.fields);
}

const written=[];
if(write)for(let index=0;index<operations.length;index+=250){
  const batch=createBatch(operations.slice(index,index+250));
  const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/korpholmenrunt/ops').replace(/^\/korpholmenrunt\/ops\//,'');
  const path=resolve(opsRoot,relative);const content=`${JSON.stringify(batch,null,2)}\n`;
  await mkdir(opsRoot,{recursive:true});
  try{await writeFile(path,content,{flag:'wx'});written.push(path)}catch(error){if(error.code!=='EEXIST')throw error;const current=await readFile(path,'utf8');if(current!==content)throw new Error(`Befintlig batch skiljer sig och skrivs inte över: ${path}`)}
}

const after=materialize([...existingOps,...operations]);
const afterResults=after.listEntities('race-result').map(entity=>({id:entity.entity_id,...entity.fields}));
const afterLinks=after.listEntities('race-person-link').map(entity=>({id:entity.entity_id,...entity.fields}));
const bannedResultFields=['captain_raw','crew_1_raw','crew_2_raw','person_link_ids'];
const bannedLinkFields=['source_field','source_parent_field'];
if(afterResults.some(result=>bannedResultFields.some(field=>Object.hasOwn(result,field))))throw new Error('Gamla deltagarfält finns kvar på resultat');
if(afterLinks.some(link=>bannedLinkFields.some(field=>Object.hasOwn(link,field))))throw new Error('Gamla rollfält finns kvar på deltagarlänkar');
if(afterResults.some(result=>!Array.isArray(result.participants_raw)||!Array.isArray(result.participant_link_ids)))throw new Error('Nya deltagarfält saknas på resultat');
if(afterLinks.some(link=>link.role!=='tävlande'||!Number.isInteger(link.participant_group)||!Number.isInteger(link.participant_order)))throw new Error('Deltagarlänkarna följer inte v3-modellen');
const afterResultById=new Map(afterResults.map(({id,...fields})=>[id,fields]));
const afterLinkById=new Map(afterLinks.map(({id,...fields})=>[id,fields]));
for(const result of transformedResults)if(canonicalStringify(afterResultById.get(result.id))!==canonicalStringify(result.fields))throw new Error(`Resultatet ändrades utöver den avsedda v3-konverteringen: ${result.id}`);
for(const link of transformedLinks)if(canonicalStringify(afterLinkById.get(link.id))!==canonicalStringify(link.fields))throw new Error(`Deltagarlänken ändrades utöver den avsedda v3-konverteringen: ${link.id}`);
for(const result of afterResults)for(const linkId of result.participant_link_ids)if(transformedLinkById.has(linkId)&&transformedLinkById.get(linkId).result_id!==result.id)throw new Error(`Fel resultatkoppling för ${linkId}`);

console.log(JSON.stringify({target:opsRoot,dry_run:!write,already_v3:alreadyV3,results:results.length,participant_links:links.length,connected_people:links.filter(link=>link.person_id).length,confirmed_links:links.filter(link=>link.confirmed===true).length,placeholders:links.filter(link=>link.participant_kind==='placeholder').length,split_links:links.filter(link=>link.split_root_link_id).length,roots:roots.length,operations:operations.length,batches_written:written.length,schema_version:3,participant_role:'tävlande'},null,2));
