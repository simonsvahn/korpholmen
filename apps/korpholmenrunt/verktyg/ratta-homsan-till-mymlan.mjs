import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  batchPath,
  compareHLC,
  createBatch,
  createClock,
  createSetOperation,
  materialize,
  validateBatch,
} from '../../../packages/core/data-layer.js';

const DEVICE='korpholmenrunt-ratta-homsan-mymlan-20260806';
const RESULT_ID='race-result:analog-img-7402-2010-02';
const requestedRoot=process.argv[2];
const write=process.argv.includes('--write');
if(!requestedRoot)throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
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
const resultEntity=before.getEntity('race-result',RESULT_ID);
if(!resultEntity)throw new Error(`Resultatet saknas: ${RESULT_ID}`);
const result={id:RESULT_ID,...resultEntity.fields};

for(const [field,expected] of Object.entries({year:2010,boat_name_raw:'Homsan',boat_id:'mymlan',class_id:'kajak-1'})){
  if(result[field]!==expected)throw new Error(`Avbryter: ${RESULT_ID}.${field} är ${JSON.stringify(result[field])}, väntade ${JSON.stringify(expected)}`);
}
const rawSourceBoat=result.raw_row?.fartyg??result.raw_row?.farkost_eller_notering_raw;
if(rawSourceBoat!=='Homsan')throw new Error('Avbryter: råkällan är inte den väntade Homsan-raden');

const correction={
  boat_name_corrected:'Mymlan',
  boat_name_correction_status:'bekräftad källrättelse',
  boat_name_correction_note:'Homsan i källan är en felskrivning. Farkosten är kajaken Mymlan; motorbåten Homsan har aldrig deltagit i Korpholmen runt. Beslut av Simon 2026-08-06.',
  boat_match_status:'manuell',
  boat_match_method:'Källfelskrivningen Homsan rättad av Simon 2026-08-06; farkosten är kajaken Mymlan',
  boat_candidate_ids:['mymlan'],
};
const plans=Object.entries(correction).filter(([field,value])=>JSON.stringify(result[field])!==JSON.stringify(value));
const currentSeq=existingOps.filter(operation=>operation.device_id===DEVICE).reduce((maximum,operation)=>Math.max(maximum,operation.seq),0);
const latestHlc=existingOps.map(operation=>operation.hlc).reduce((latest,value)=>!latest||compareHLC(value,latest)>0?value:latest,null);
const clock=createClock(DEVICE,()=>Date.now(),latestHlc);
let seq=currentSeq;
const operations=plans.map(([field,value])=>createSetOperation({
  deviceId:DEVICE,
  seq:++seq,
  entityType:'race-result',
  entityId:RESULT_ID,
  field,
  value,
  hlc:clock.tick(),
}));

const written=[];
if(write&&operations.length){
  for(let index=0;index<operations.length;index+=250){
    const batch=createBatch(operations.slice(index,index+250));
    const relative=batchPath(batch.device_id,batch.from_seq,batch.to_seq,'/korpholmenrunt/ops').replace(/^\/korpholmenrunt\/ops\//,'');
    const path=resolve(opsRoot,relative);
    const content=`${JSON.stringify(batch,null,2)}\n`;
    await mkdir(opsRoot,{recursive:true});
    try{
      await writeFile(path,content,{flag:'wx'});
      written.push(path);
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const existing=await readFile(path,'utf8');
      if(existing!==content)throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`);
    }
  }
}

const after=materialize([...existingOps,...operations]);
const corrected=after.getEntity('race-result',RESULT_ID)?.fields;
if(corrected?.boat_name_corrected!=='Mymlan'||corrected?.boat_id!=='mymlan')throw new Error('Källrättelsen kunde inte verifieras');
const correctedRawSourceBoat=corrected?.raw_row?.fartyg??corrected?.raw_row?.farkost_eller_notering_raw;
if(correctedRawSourceBoat!=='Homsan'||corrected?.boat_name_raw!=='Homsan')throw new Error('Råkällan ändrades oväntat');
const homsanLinks=after.listEntities('race-result').filter(entity=>entity.fields.boat_id==='homsan');
if(homsanLinks.length)throw new Error(`${homsanLinks.length} resultat är fortfarande kopplade till motorbåten Homsan`);

console.log(JSON.stringify({
  target:opsRoot,
  dry_run:!write,
  result_id:RESULT_ID,
  displayed_boat:corrected.boat_name_corrected,
  linked_boat_id:corrected.boat_id,
  raw_source_preserved:corrected.boat_name_raw,
  homsan_result_links:homsanLinks.length,
  operations:operations.length,
  batches_written:written,
},null,2));
