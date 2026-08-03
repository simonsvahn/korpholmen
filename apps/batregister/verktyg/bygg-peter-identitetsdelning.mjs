import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeleteOperation, createSetOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-01/initial-ops.json');
const SOURCE_PATH=resolve(PRIVATE,'kallkopior/byggkit/batregister.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-03-peter-identitetsdelning.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const DEVICE='correction-batregister-peter-identitetsdelning-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,4,0,45,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const [baseBytes,sourceBytes]=await Promise.all([readFile(BASE_PATH),readFile(SOURCE_PATH)]);
const baseDocument=JSON.parse(baseBytes);const source=JSON.parse(sourceBytes);
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const previousOperations=[...baseDocument.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])];
const previousState=materialize(previousOperations);

const boatsById=new Map((source.batar||source.boats||[]).map(boat=>[boat.id,boat]));
for(const boatId of ['lassemaja','tillfälligheten']){
  const boat=boatsById.get(boatId);
  if(!boat||(boat.kbk_personer||[]).some(value=>value==='Junior Peter = Peter Neretnieks')===false)throw new Error(`${boatId}: källans uttryckliga Peter Neretnieks-koppling saknas.`);
}
if(!previousState.getEntity('boat-person-link','lassemaja--peterholm')||!previousState.getEntity('boat-person-link','tillfälligheten--peterholm'))throw new Error('De två felkopplingarna finns inte i väntad form.');
if(previousState.getEntity('boat-person-link','lassemaja--peterneretnieks')||previousState.getEntity('boat-person-link','tillfälligheten--peterneretnieks'))throw new Error('De rättade länkarna finns redan; korrigeringsunderlaget måste granskas.');

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}
function setFields(entityType,entityId,fields){for(const [field,value] of Object.entries(fields))set(entityType,entityId,field,value)}
function remove(entityType,entityId){seq+=1;operations.push(createDeleteOperation({deviceId:DEVICE,seq,entityType,entityId,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}

remove('boat-person-link','lassemaja--peterholm');
remove('boat-person-link','tillfälligheten--peterholm');
for(const boatId of ['lassemaja','tillfälligheten'])setFields('boat-person-link',`${boatId}--peterneretnieks`,{
  boat_id:boatId,
  person_id:'peterneretnieks',
  person_display_name:'Peter Neretnieks',
  role:'ägare/anknuten',
  confidence:'godkänd',
  source:'Båtregistrets källfält: »Junior Peter = Peter Neretnieks«; identitetsrättning 2026-08-03',
});

const finalState=materialize([...previousOperations,...operations]);
for(const boatId of ['lassemaja','tillfälligheten']){
  if(finalState.getEntity('boat-person-link',`${boatId}--peterholm`))throw new Error(`${boatId}: den felaktiga Peter Holm-länken är kvar.`);
  const link=finalState.getEntity('boat-person-link',`${boatId}--peterneretnieks`);
  if(!link||link.fields.person_id!=='peterneretnieks')throw new Error(`${boatId}: den rättade länken saknas.`);
}
if(finalState.getEntity('boat-person-link','bossanova--peterholm')?.fields.person_id!=='peterholm')throw new Error('Den korrekta BossaNova–Peter Holm-länken får inte ändras.');

const output={
  operations_version:1,
  correction_id:'peter-identitetsdelning',
  device_id:DEVICE,
  reason:'Återkallar två felaktigt bekräftade Peter Holm-länkar. Källan anger uttryckligen Junior Peter = Peter Neretnieks för Lasse-Maja och Tillfälligheten; BossaNova förblir kopplad till Peter Holm.',
  supersedes:[
    {entity_id:'lassemaja--peterholm',old_source:'Simon, bekräftat i chatten'},
    {entity_id:'tillfälligheten--peterholm',old_source:'Simon, bekräftat i chatten'},
  ],
  source_sha256:sha256(sourceBytes),
  counts:{operations:operations.length,boat_person_links:finalState.listEntities('boat-person-link').length},
  operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),
  operations,
};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(output,null,2)}\n`);
console.log('Båtidentitetsrättning: Lasse-Maja och Tillfälligheten pekar på Peter Neretnieks; BossaNova pekar fortsatt på Peter Holm.');
