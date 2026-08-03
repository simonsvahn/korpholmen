import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-04-grundarmatrikel-1940-tal.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const DEVICE='correction-klubbhistorik-grundarmatrikel-2026-08-04';
const CLOCK_MS=Date.UTC(2026,7,4,9,0,0);
const RELEASE_ID='matrikel-grundare-1940-tal';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const baseDocument=JSON.parse(await readFile(BASE_PATH,'utf8'));
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const previousOperations=[...baseDocument.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])];
const previousState=materialize(previousOperations);

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}
function setFields(entityType,entityId,fields){for(const [field,value] of Object.entries(fields))set(entityType,entityId,field,value)}

const evidenceSources=[
  {
    id:'TRY-HEDSTROM',
    label:'Bibbi Hedström intervjuad 1989, publicerad 1990',
    kind:'förstahandsminne',
    contribution:'Familjerna, deras platser och uppgiften att klubben bildades efter krigsslutet.',
  },
  {
    id:'TRY-MAMMA',
    label:'Lena Böving, Är mamma lik sin mamma (2003)',
    kind:'retrospektiv familjeberättelse',
    contribution:'Tio ursprungliga medlemmar; kvinnorna namnges som Bibbi, Ilse, Rut, Brita och Anna-Greta.',
  },
  {
    id:'TRY-SLAKTEN',
    label:'Lena Böving, Släkten följa släktens gång (2019)',
    kind:'retrospektiv familjeberättelse',
    contribution:'Klubben dateras till mitten av 1940-talet och kopplas till bensinransoneringen.',
  },
  {
    id:'ARK-1954',
    label:'KBK:s protokoll 29 januari 1954',
    kind:'samtida klubbhandling',
    contribution:'Samtliga tio återfinns tillsammans; därutöver Per Olof och Inger Bethge.',
  },
  {
    id:'MATR-1986',
    label:'KBK:s medlemsmatrikel juli 1986',
    kind:'samtida matrikel',
    contribution:'Bethge-paret har invalsår 1953 och räknas därför inte som medlemmar i 1940-talsrekonstruktionen.',
  },
];

const members=[
  {personId:'carlgunderhedström',name:'Carl-Gunder Hedström',clubName:'Broder Carl Gunder',island:'Korpholmen',place:'',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM: familjerna Hedström flyttade ut till Korpholmen 1939 och bildade senare klubben därifrån.'},
  {personId:'bibbihedström',name:'Bibbi Hedström',clubName:'Syster Bibbi',island:'Korpholmen',place:'',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM: Bibbi och Carl-Gunder bodde på Korpholmen från 1939.'},
  {personId:'nilshenrikhedström',name:'Nils-Henrik Hedström',clubName:'Broder Nils Henrik',island:'Korpholmen',place:'',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM: Ilse och Nils-Henrik hör till den andra Hedström-familjen på Korpholmen.'},
  {personId:'ilsehedström',name:'Ilse Hedström',clubName:'',island:'Korpholmen',place:'',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM: Ilse och Nils-Henrik hör till den andra Hedström-familjen på Korpholmen.'},
  {personId:'carlhenriknordlander',name:'Carl-Henrik Nordlander',clubName:'',island:'Yxlan',place:'hus på Yxlan',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver uttryckligen att Carl-Henrik och Anna-Greta Nordlander köpte hus på Yxlan.'},
  {personId:'annagretanordlander',name:'Anna-Greta Nordlander',clubName:'',island:'Yxlan',place:'hus på Yxlan',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver uttryckligen att Carl-Henrik och Anna-Greta Nordlander köpte hus på Yxlan.'},
  {personId:'peraxelweslien',name:'Per-Axel Weslien',clubName:'',island:'Yxlan',place:'Alsvassen',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver att Per-Axel och Rut Weslien semestrade i Alsvassen. Yxlan är den normaliserade ön; uppgiften avser grundartiden.'},
  {personId:'rutweslien',name:'Rut Weslien',clubName:'',island:'Yxlan',place:'Alsvassen',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver att Per-Axel och Rut Weslien semestrade i Alsvassen. Yxlan är den normaliserade ön; uppgiften avser grundartiden.'},
  {personId:'allanune',name:'Allan Une',clubName:'',island:'Stugholmen',place:'hyrställe',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver uttryckligen att Allan och Brita Une hyrde på Stugholmen.'},
  {personId:'britaune',name:'Brita Une',clubName:'',island:'Stugholmen',place:'hyrställe',placeConfidence:'hög',placeEvidence:'TRY-HEDSTROM skriver uttryckligen att Allan och Brita Une hyrde på Stugholmen.'},
];

for(const member of members){
  const ref=previousState.getEntity('person-ref',`person-ref:${member.personId}`);
  if(!ref||ref.fields.external_id!==member.personId)throw new Error(`Stabil personreferens saknas: ${member.personId}`);
}

setFields('matrikel-release',RELEASE_ID,{
  title:'Grundarmatrikeln (rekonstruktion)',
  release_type:'rekonstruerad grundarmatrikel',
  release_class:'reconstruction',
  is_reconstruction:true,
  reconstruction_status:'arbetsrekonstruktion för manuell granskning',
  year:1945,
  as_of:'cirka 1945',
  date_from:1943,
  date_to:1945,
  date_precision:'intervall',
  date_confidence:'medel',
  date_note:'Källorna pekar på mitten av 1940-talet respektive efter krigsslutet; exakt grundningsår är olöst.',
  source_document_id:null,
  source_document_ids:[],
  evidence_source_ids:evidenceSources.map(source=>source.id),
  evidence_sources:evidenceSources,
  method_note:'Ingen bevarad grundarmatrikel är känd. Utgåvan är en källkorsläst rekonstruktion och får inte visas som ett originaldokument.',
  exclusion_note:'Per Olof och Inger Bethge ingår inte eftersom deras invalsår är belagt som 1953.',
  person_row_count:members.length,
  source_member_row_count:null,
  boat_occurrence_count:0,
  retained:true,
});

for(const [index,member] of members.entries()){
  const occurrenceId=`person-occurrence:grundare-1940-tal:${String(index+1).padStart(3,'0')}`;
  setFields('person-occurrence',occurrenceId,{
    release_id:RELEASE_ID,
    order:index+1,
    raw_text:member.name,
    person_name_raw:member.name,
    club_name_raw:member.clubName,
    club_name_core_raw:member.clubName,
    membership_status:'founder',
    induction_year:null,
    induction_year_raw:'cirka 1945',
    induction_year_estimate:1945,
    island_raw:member.island,
    place_detail_raw:member.place,
    residence_at_time:true,
    place_confidence:member.placeConfidence,
    place_evidence:member.placeEvidence,
    membership_confidence:'hög',
    membership_evidence:'TRY-MAMMA anger tio ursprungliga medlemmar; TRY-HEDSTROM namnger de fem familjerna och ARK-1954 visar samma tio personer tillsammans.',
    evidence_source_ids:['TRY-HEDSTROM','TRY-MAMMA','TRY-SLAKTEN','ARK-1954'],
    is_reconstruction:true,
    source_entity_kind:'person',
    person_id:member.personId,
    match_status:'godkand',
    match_method:'källkorsläst rekonstruktion',
    candidate_ids:[member.personId],
    confirmed:true,
    retained:true,
  });
}

const finalState=materialize([...previousOperations,...operations]);
const release=finalState.getEntity('matrikel-release',RELEASE_ID);
const finalMembers=finalState.listEntities('person-occurrence').map(entity=>({id:entity.entity_id,...entity.fields})).filter(item=>item.retained!==false&&item.release_id===RELEASE_ID);
if(!release||release.fields.is_reconstruction!==true)throw new Error('Grundarmatrikelns release skapades inte.');
if(finalMembers.length!==10||new Set(finalMembers.map(item=>item.person_id)).size!==10)throw new Error('Grundarmatrikeln ska innehålla exakt tio stabila personer.');
if(finalMembers.some(item=>['perolofbethge','ingerbethge'].includes(item.person_id)))throw new Error('Bethge-paret får inte ingå i 1940-talsrekonstruktionen.');

const output={
  operations_version:1,
  correction_id:'grundarmatrikel-1940-tal',
  device_id:DEVICE,
  reason:'Skapar en uttryckligen rekonstruerad grundarmatrikel med tio källkorslästa personer, tidsbundna bostadsöar, evidens och synlig osäkerhet utan att låtsas att ett originaldokument finns.',
  evidence_sources:evidenceSources,
  counts:{operations:operations.length,releases:1,person_occurrences:members.length},
  operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),
  operations,
};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(output,null,2)}\n`);
console.log(`Grundarmatrikel: ${members.length} personer, fyra tidsbundna ö-/platsgrupper och ${evidenceSources.length} källor.`);
