import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeleteOperation, createSetOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-03-peter-identitetsdelning.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const DEVICE='correction-klubbhistorik-peter-identitetsdelning-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,4,0,30,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const baseDocument=JSON.parse(await readFile(BASE_PATH,'utf8'));
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE&&file!=='2026-08-05-matrikel-1996.json').sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const previousOperations=[...baseDocument.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])];
const previousState=materialize(previousOperations);

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}
function setFields(entityType,entityId,fields){for(const [field,value] of Object.entries(fields))set(entityType,entityId,field,value)}
function remove(entityType,entityId){seq+=1;operations.push(createDeleteOperation({deviceId:DEVICE,seq,entityType,entityId,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}

const occurrences=previousState.listEntities('person-occurrence').map(entity=>({id:entity.entity_id,...entity.fields}));
const byRawName=name=>occurrences.filter(item=>item.person_name_raw===name);
const activeByRawName=name=>byRawName(name).filter(item=>item.retained!==false);
const expectedActiveCounts={
  'Peter Neretnieks':14,
  'Peter Holm':6,
  'Anna Neretnieks':6,
  'Anna Holm':6,
};
for(const [name,count] of Object.entries(expectedActiveCounts)){
  const actual=activeByRawName(name).length;
  if(actual!==count)throw new Error(`${name}: ${actual} aktiva förekomster, väntat ${count}.`);
}

function connectName(name,personId,method,note){
  for(const item of byRawName(name))setFields('person-occurrence',item.id,{
    person_id:personId,
    match_status:'godkand',
    match_method:method,
    candidate_ids:[personId],
    confirmed:true,
    decision_note:note,
  });
}

connectName('Peter Neretnieks','peterneretnieks','källbelagd identitetsdelning','Peter Neretnieks (f. 1965) är Anna och Susanne Neretnieks bror, inte Peter Holm. Rättelsen ersätter den tidigare felaktiga sammanslagningen.');
connectName('Peter Holm','peterholm','källbelagd identitetsdelning','Peter Holm (f. 1971), Broder Peter-Pedal, är Anna Holms man och en annan person än Peter Neretnieks.');
connectName('Anna Neretnieks','annaholm','källbelagt namnbyte','Anna Neretnieks och Anna Holm är samma person; Anna tog maken Peter Holms efternamn.');
connectName('Anna Holm','annaholm','källbelagt namnbyte','Anna Holm är den senare namnformen för Anna Neretnieks efter giftermålet med Peter Holm.');

setFields('person-ref','person-ref:peterneretnieks',{
  external_id:'peterneretnieks',display_name:'Peter Neretnieks',full_name:'Peter Neretnieks',birth_name:'',birth:1965,
  club_name:'Broder Peter-K',aliases:[],url:'../matrikel/?person=peterneretnieks',
});
setFields('person-ref','person-ref:peterholm',{
  external_id:'peterholm',display_name:'Peter Holm',full_name:'Peter Holm',birth_name:'',birth:1971,
  club_name:'Broder Peter-Pedal',aliases:[],url:'../matrikel/?person=peterholm',
});
setFields('person-ref','person-ref:annaholm',{
  external_id:'annaholm',display_name:'Anna Holm',full_name:'Anna Holm',birth_name:'Anna Neretnieks',birth:1974,
  club_name:'Syster Anna',aliases:['Anna Neretnieks'],url:'../matrikel/?person=annaholm',
});

const wrongChange=previousState.getEntity('name-change-candidate','name-change-candidate:003');
if(!wrongChange||wrongChange.fields.from_name!=='Peter Neretnieks'||wrongChange.fields.to_name!=='Peter Holm')throw new Error('Det tidigare felaktiga Peter-namnbytet hittades inte i väntad form.');
remove('name-change-candidate','name-change-candidate:003');
setFields('name-change-candidate','name-change-candidate:004',{
  person_id:'annaholm',from_release_id:'matrikel-1980',to_release_id:'matrikel-2020',from_name:'Anna Neretnieks',to_name:'Anna Holm',
  basis:'Verkligt efternamnsbyte vid giftermål med Peter Holm; bekräftat av Simon 2026-08-03 och stött av matriklarnas namnformer före respektive efter bytet.',
  status:'belagd kandidat',writes_to_person_master:false,
});

const finalState=materialize([...previousOperations,...operations]);
const activeFinal=finalState.listEntities('person-occurrence').map(entity=>({id:entity.entity_id,...entity.fields})).filter(item=>item.retained!==false);
if(activeFinal.some(item=>item.person_name_raw==='Peter Neretnieks'&&item.person_id!=='peterneretnieks'))throw new Error('Någon aktiv Peter Neretnieks är fortfarande felkopplad.');
if(activeFinal.some(item=>item.person_name_raw==='Peter Holm'&&item.person_id!=='peterholm'))throw new Error('Någon aktiv Peter Holm är fortfarande felkopplad.');
if(activeFinal.some(item=>item.person_name_raw==='Anna Neretnieks'&&item.person_id!=='annaholm'))throw new Error('Någon aktiv Anna Neretnieks är fortfarande okopplad.');
for(const year of [2020,2021,2022,2023,2024,2025]){
  const rows=activeFinal.filter(item=>item.release_id===`matrikel-${year}`&&['Peter Neretnieks','Peter Holm'].includes(item.person_name_raw));
  if(rows.length!==2||new Set(rows.map(item=>item.person_id)).size!==2)throw new Error(`${year}: de två Peter-raderna är inte två identiteter.`);
}

const output={
  operations_version:1,
  correction_id:'peter-identitetsdelning',
  device_id:DEVICE,
  reason:'Återkallar den felaktiga sammanslagningen Peter Neretnieks → Peter Holm, registrerar Annas verkliga namnbyte och bevarar alla källformer oförändrade.',
  supersedes:[
    {release_id:'matrikel-1986',raw_name:'Peter Neretnieks',old_person_id:'peterholm'},
    {release_id:'matrikel-2025',raw_name:'Peter Neretnieks',old_person_id:'peterholm'},
    {candidate_id:'name-change-candidate:003',old_change:'Peter Neretnieks → Peter Holm'},
  ],
  evidence:{
    direct_user_correction:'Simon 2026-08-03',
    independent_source_check:'Peter Neretnieks (1965) och Peter Holm (1971) står som två samtidiga rader i matriklarna 2020–2025; Anna Neretnieks står i äldre matriklar och Anna Holm i de moderna.',
  },
  counts:{operations:operations.length,active_peter_neretnieks:activeByRawName('Peter Neretnieks').length,active_peter_holm:activeByRawName('Peter Holm').length,active_anna_neretnieks:activeByRawName('Anna Neretnieks').length},
  operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),
  operations,
};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(output,null,2)}\n`);
console.log(`Identitetsdelning: ${activeByRawName('Peter Neretnieks').length} aktiva Peter Neretnieks-rader och ${activeByRawName('Peter Holm').length} Peter Holm-rader hålls isär.`);
