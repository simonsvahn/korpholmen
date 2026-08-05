import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const SOURCE_PATH=resolve(PRIVATE,'kallkopior/matriklar/matrikel-1996.json');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-05-matrikel-1996.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const REPORT_PATH=resolve(PRIVATE,'migrering-2026-08-02/kontrollrapport-matrikel-1996.json');
const DEVICE='ingest-klubbhistorik-matrikel-1996-2026-08-05';
const CLOCK_MS=Date.UTC(2026,7,5,9,0,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>normalize(value).replaceAll(' ','');
const unique=values=>[...new Set(values.filter(Boolean))];
const array=value=>Array.isArray(value)?value:value?[value]:[];
const pad=value=>String(value).padStart(3,'0');
const indexPush=(index,key,value)=>{if(!key)return;if(!index.has(key))index.set(key,[]);index.get(key).push(value)};

const [sourceBytes,baseBytes]=await Promise.all([readFile(SOURCE_PATH),readFile(BASE_PATH)]);
const source=JSON.parse(sourceBytes);const base=JSON.parse(baseBytes);
if(source.schema_version!==2||source.release.id!=='matrikel-1996'||source.release.year!==1996)throw new Error('Fel eller saknad årsfil för matrikel 1996.');

const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort((a,b)=>a.localeCompare(b,'sv'));
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const priorOperations=[...base.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])];
const priorState=materialize(priorOperations);
const existingRelease=priorState.getEntity('matrikel-release','matrikel-1996');
if(existingRelease&&existingRelease.fields.retained!==false)throw new Error('Matrikel 1996 finns redan i föregående masterläge.');

const historicalPersonIndex=new Map();
for(const entity of priorState.listEntities('person-occurrence')){
  const item=entity.fields;
  if(item.retained!==false&&item.person_id&&item.confirmed)indexPush(historicalPersonIndex,normalize(item.person_name_raw),item.person_id);
}
const personRefs=priorState.listEntities('person-ref').map(entity=>({id:entity.fields.external_id||entity.entity_id.replace(/^person-ref:/,''),...entity.fields}));
const personNameIndex=new Map();const firstNameIndex=new Map();const clubCoreIndex=new Map();const personTokenSets=new Map();
for(const person of personRefs){
  const names=unique([person.display_name,person.full_name,person.birth_name,...array(person.aliases)]);
  const tokens=new Set();
  for(const name of names){
    indexPush(personNameIndex,normalize(name),person.id);
    indexPush(firstNameIndex,normalize(name).split(' ')[0],person.id);
    for(const token of normalize(name).split(' ').filter(Boolean))tokens.add(token);
  }
  personTokenSets.set(person.id,tokens);
  if(person.club_name)indexPush(clubCoreIndex,normalize(person.club_name).replace(/^(broder|syster|s)\s+/,'').trim(),person.id);
}

function personMatch(name,clubCore){
  const historical=unique(historicalPersonIndex.get(normalize(name))||[]);
  if(historical.length===1)return {person_id:historical[0],match_status:'godkand',match_method:'tidigare källbelagd personidentitet',candidate_ids:historical,confirmed:true};
  const exact=unique(personNameIndex.get(normalize(name))||[]);
  if(exact.length===1)return {person_id:exact[0],match_status:'kopplad',match_method:'exakt personnamn',candidate_ids:exact,confirmed:true};
  const sourceTokens=normalize(name).split(' ').filter(Boolean);
  const contained=sourceTokens.length<2?[]:personRefs.filter(person=>sourceTokens.every(token=>personTokenSets.get(person.id)?.has(token))).map(person=>person.id);
  if(contained.length===1)return {person_id:contained[0],match_status:'godkand',match_method:'unikt historiskt namn ingår i aktuellt fullständigt namn',candidate_ids:contained,confirmed:true};
  const core=clubCore?unique(clubCoreIndex.get(normalize(clubCore))||[]):[];
  if(core.length===1)return {person_id:core[0],match_status:'kopplad',match_method:'exakt klubbnamnskärna',candidate_ids:core,confirmed:true};
  const first=normalize(name).split(' ')[0];
  const candidates=unique([...(personNameIndex.get(normalize(name))||[]),...(firstNameIndex.get(first)||[])]).slice(0,12);
  return {person_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates,confirmed:false};
}

const historicalBoatIndex=new Map();
for(const entity of priorState.listEntities('boat-occurrence')){
  const item=entity.fields;
  if(item.retained!==false&&item.boat_id&&item.confirmed)indexPush(historicalBoatIndex,`${item.prefix||''}:${compact(item.boat_name_raw)}`,item.boat_id);
}
const boatRefs=priorState.listEntities('boat-ref').map(entity=>({id:entity.fields.external_id||entity.entity_id.replace(/^boat-ref:/,''),...entity.fields}));
const boatIndex=new Map();
for(const boat of boatRefs){
  const snapshot=boat.snapshot||{};
  const names=unique([boat.name,...array(boat.aliases),snapshot.namn,snapshot.dopnamn,snapshot.onskat_namn,...array(snapshot.smeknamn),...array(snapshot.tidigare_namn),...array(snapshot.senare_namn)]);
  for(const name of names.flatMap(value=>String(value||'').split(/\/|\balias\b|\sa\.\s/i)))indexPush(boatIndex,compact(name),boat.id);
}

function boatMatch(component){
  const key=`${component.prefix||''}:${compact(component.boat_name_raw)}`;
  const historical=unique(historicalBoatIndex.get(key)||[]);
  if(historical.length===1)return {boat_id:historical[0],match_status:'godkand',match_method:'tidigare källbelagd båtidentitet',candidate_ids:historical,confirmed:true};
  if(compact(component.boat_name_raw)==='babbii'&&boatRefs.some(boat=>boat.id==='babbb'))return {boat_id:'babbb',match_status:'godkand',match_method:'källform för Babbb II',candidate_ids:['babbb'],confirmed:true};
  const keys=unique([component.boat_name_raw,...String(component.boat_name_raw||'').split(/\balias\b|\sa\.\s|\//i)].map(compact));
  const exact=unique(keys.flatMap(name=>boatIndex.get(name)||[]));
  if(exact.length===1)return {boat_id:exact[0],match_status:'kopplad',match_method:'exakt namn eller alias',candidate_ids:exact,confirmed:true};
  return {boat_id:null,match_status:exact.length?'foreslagen':'saknas',match_method:exact.length?'namnkandidater':'ingen träff',candidate_ids:exact.slice(0,12),confirmed:false};
}

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}
function setFields(entityType,entityId,fields){for(const [field,value] of Object.entries(fields))set(entityType,entityId,field,value)}

const releaseId=source.release.id;const documentId=source.document.id;
setFields('source-document',documentId,{
  label:source.document.label,
  private_copy:'privat/kallkopior/matriklar/matrikel-1996.json',
  sha256:sha256(sourceBytes),
  source_type:source.document.source_type,
  source_file_hashes:Object.fromEntries(source.document.original_files.map(file=>[file.original_filename,file.sha256])),
  source_file_count:source.document.original_files.length,
  selected_source_document_id:documentId,
  selected_source_release_id:releaseId,
  is_primary_for_release:true,
  release_id:releaseId,
  sort_order:source.release.sort_order,
  retained:true,
  selection_note:'Vald årsfil. Fotografiernas originalnamn och SHA-256 bevaras i års-JSON; de kanoniska privatkopiorna är byteidentiska.',
  immutable:true,
  schema_version:source.schema_version,
});

const canonicalMemberRows=new Map();const canonicalBoatRows=new Map();
const personOccurrences=[];const boatOccurrences=[];
for(const row of source.member_rows){
  const rowId=`source-row:canonical:${documentId}:member:${pad(row.order)}`;canonicalMemberRows.set(row.id,rowId);
  const occurrenceIds=[];
  for(const component of row.person_components||[]){
    const occurrenceId=`person-occurrence:${releaseId}:${pad(row.order)}${component.order>1?`:component:${String(component.order).padStart(2,'0')}`:''}`;
    const match=personMatch(component.person_name_raw,row.club_name_core_raw);
    const fields={
      release_id:releaseId,source_document_id:documentId,source_row_id:rowId,canonical_source_row_id:rowId,order:row.order,
      raw_text:row.raw_text,source_page:row.page,source_annotation:row.source_annotation,person_name_raw:component.person_name_raw,
      source_person_name_raw:row.person_name_raw,source_entity_kind:row.entity_kind,component_order:component.order,
      club_name_core_raw:row.club_name_core_raw,membership_status:row.category,induction_year_raw:row.induction_year_raw,
      induction_year:row.induction_year,age_raw:row.age_raw,birth_year_raw:row.birth_year_raw,birth_year:row.birth_year,
      birth_date_raw:row.birth_date_raw,birth_date:row.birth_date,island_raw:row.island_raw,club_name_raw:row.club_name_raw,
      relation_raw:row.relation_raw,retained:true,...match,
    };
    personOccurrences.push({id:occurrenceId,...fields});occurrenceIds.push(occurrenceId);setFields('person-occurrence',occurrenceId,fields);
  }
  setFields('source-row',rowId,{release_id:releaseId,source_document_id:documentId,kind:'person',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,source_entity_kind:row.entity_kind,person_component_count:row.person_components.length,occurrence_ids:occurrenceIds,retained:true});
}

let boatOrder=0;
for(const row of source.boat_rows){
  const rowId=`source-row:canonical:${documentId}:boat:${pad(row.order)}`;canonicalBoatRows.set(row.id,rowId);const occurrenceIds=[];
  for(const component of row.components){
    boatOrder+=1;const occurrenceId=`boat-occurrence:${releaseId}:${pad(row.order)}:${String(component.order).padStart(2,'0')}`;const match=boatMatch(component);
    const fields={
      release_id:releaseId,source_document_id:documentId,source_row_id:rowId,canonical_source_row_id:rowId,order:boatOrder,
      source_line_order:row.order,component_order:component.order,source_page:row.page,source_category:row.category,
      source_annotation:row.source_annotation,raw_text:component.raw_text,source_line_raw:row.raw_text,prefix:component.prefix,
      boat_name_raw:component.boat_name_raw,registry_year_raw:component.registry_year_raw,registry_year:component.registry_year,
      registry_years:component.registry_years,registry_periods:component.registry_periods||[],retained:true,...match,
    };
    boatOccurrences.push({id:occurrenceId,...fields});occurrenceIds.push(occurrenceId);setFields('boat-occurrence',occurrenceId,fields);
  }
  setFields('source-row',rowId,{release_id:releaseId,source_document_id:documentId,kind:'boat',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,associated_member_source_row_id:row.associated_member_row_id?canonicalMemberRows.get(row.associated_member_row_id)||null:null,occurrence_ids:occurrenceIds,retained:true});
}

for(const row of source.layout_rows){
  setFields('source-layout-row',row.id,{release_id:releaseId,source_document_id:documentId,order:row.order,source_page:row.page,kind:row.kind,section:row.section,text_raw:row.text_raw,member_source_row_id:row.member_row_id?canonicalMemberRows.get(row.member_row_id)||null:null,boat_source_row_ids:row.boat_row_ids.map(id=>canonicalBoatRows.get(id)).filter(Boolean),retained:true});
}

const personCategories=Object.fromEntries([...new Set(source.member_rows.map(row=>row.category))].map(category=>[category,source.member_rows.filter(row=>row.category===category).length]));
const boatCategories=Object.fromEntries([...new Set(source.boat_rows.map(row=>row.category))].map(category=>[category,source.boat_rows.filter(row=>row.category===category).length]));
setFields('matrikel-release',releaseId,{...source.release,source_document_id:documentId,source_document_ids:[documentId],person_row_count:personOccurrences.length,source_member_row_count:source.member_rows.length,person_category_counts:personCategories,boat_source_row_count:source.boat_rows.length,boat_occurrence_count:boatOccurrences.length,boat_category_counts:boatCategories,layout_row_count:source.layout_rows.length,canonical_schema_version:source.schema_version,source_variant_policy:'en JSON per kalenderår',retained:true});

const previousRoot=priorState.getEntity('club-history-root','club-history-root:kbk')?.fields||{};
const activeReleases=priorState.listEntities('matrikel-release').map(entity=>({id:entity.entity_id,...entity.fields})).filter(item=>item.retained!==false);
const releaseIds=[...activeReleases,{id:releaseId,...source.release}].sort((a,b)=>String(a.as_of||a.year||'').localeCompare(String(b.as_of||b.year||''),'sv')).map(item=>item.id);
setFields('club-history-root','club-history-root:kbk',{
  release_ids:releaseIds,
  canonical_source_hashes:{...(previousRoot.canonical_source_hashes||{}),[documentId]:sha256(sourceBytes)},
  canonical_schema_version:2,
  source_document_count:(previousRoot.source_document_count||priorState.listEntities('source-document').filter(entity=>entity.fields.retained!==false).length)+1,
  source_variant_policy:'en validerad JSON per kalenderår; alternativa exporter bevaras endast som källproveniens',
});

const finalState=materialize([...priorOperations,...operations]);
const finalRelease=finalState.getEntity('matrikel-release',releaseId)?.fields;
if(!finalRelease||finalRelease.person_row_count!==personOccurrences.length||finalRelease.boat_occurrence_count!==boatOccurrences.length)throw new Error('Slutkontrollen av matrikel 1996 misslyckades.');

const report={
  generated_on:'2026-08-05',
  contract:'Varje synlig medlemsrad, båtrad och layoutrad bevaras. Källplacering är inte automatiskt ett ägarpåstående.',
  source_sha256:sha256(sourceBytes),
  source_file_hashes:Object.fromEntries(source.document.original_files.map(file=>[file.original_filename,file.sha256])),
  counts:{member_source_rows:source.member_rows.length,person_occurrences:personOccurrences.length,boat_source_rows:source.boat_rows.length,boat_occurrences:boatOccurrences.length,layout_rows:source.layout_rows.length,operations:operations.length},
  person_categories:personCategories,
  boat_categories:boatCategories,
  connected_people:personOccurrences.filter(item=>item.person_id&&item.confirmed).length,
  unresolved_people:personOccurrences.filter(item=>!item.person_id||!item.confirmed).map(item=>({occurrence_id:item.id,raw_name:item.person_name_raw,status:item.match_status,candidate_ids:item.candidate_ids})),
  connected_boats:boatOccurrences.filter(item=>item.boat_id&&item.confirmed).length,
  unresolved_boats:boatOccurrences.filter(item=>!item.boat_id||!item.confirmed).map(item=>({occurrence_id:item.id,raw_name:item.boat_name_raw,prefix:item.prefix,registry_year_raw:item.registry_year_raw,status:item.match_status,candidate_ids:item.candidate_ids})),
};
const output={operations_version:1,ingest_id:'klubbhistorik-matrikel-1996-2026-08-05',device_id:DEVICE,reason:'Lägger till den bevarade medlemsmatrikeln juli 1996 som en ny årsutgåva med bytebevarade original, ordagranna källrader, källayout och granskade identitetskopplingar utan att skriva över tidigare operationsbatcher.',source_sha256:sha256(sourceBytes),operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),counts:report.counts,operations};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(output,null,2)}\n`);
await writeFile(REPORT_PATH,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
