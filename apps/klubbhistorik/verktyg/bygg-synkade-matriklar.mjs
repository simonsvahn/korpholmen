import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const SOURCES=resolve(PRIVATE,'kallkopior/matriklar');
const PEOPLE_PATH=resolve(PRIVATE,'kallkopior/matrikel-initial-archive.json');
const BOATS_PATH=resolve(PRIVATE,'kallkopior/batregister-initial-ops.json');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-03-synkade-matriklar.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const REPORT_PATH=resolve(PRIVATE,'migrering-2026-08-02/kontrollrapport-synkade-matriklar.json');
const DEVICE='ingest-klubbhistorik-synkade-matriklar-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,3,18,0,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>normalize(value).replaceAll(' ','');
const unique=values=>[...new Set(values.filter(Boolean))];
const array=value=>Array.isArray(value)?value:value?[value]:[];
const pad=value=>String(value).padStart(3,'0');

const [peopleArchive,boatDocument,baseDocument]=await Promise.all([readFile(PEOPLE_PATH,'utf8').then(JSON.parse),readFile(BOATS_PATH,'utf8').then(JSON.parse),readFile(BASE_PATH,'utf8').then(JSON.parse)]);
const downstreamFiles=new Set([OUT_FILE,'2026-08-03-ted-thunborg-dublett.json']);
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&!downstreamFiles.has(file)).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const correctionOperations=correctionDocuments.flatMap(document=>document.operations||document.ops||[]);
const historicalState=materialize([...baseDocument.operations,...correctionOperations]);
const people=peopleArchive.persons.map(person=>({id:person.id,...person.fields}));
const boatState=materialize(boatDocument.operations);
const boats=boatState.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));
const sourceFiles=(await readdir(SOURCES)).filter(file=>file.endsWith('.json')).sort((a,b)=>a.localeCompare(b,'sv'));
const sourceDocuments=await Promise.all(sourceFiles.map(async file=>{const bytes=await readFile(resolve(SOURCES,file));return {file,bytes,json:JSON.parse(bytes)}}));
const primaryDocuments=sourceDocuments.filter(source=>source.json.document.is_primary_for_release);

const personNameIndex=new Map();const firstNameIndex=new Map();const clubNameIndex=new Map();const clubCoreIndex=new Map();
function indexPush(index,key,value){if(!key)return;if(!index.has(key))index.set(key,[]);index.get(key).push(value)}
for(const person of people){
  const names=unique([person.display_name,person.full_name,person.birth_name,...array(person.aliases)]);
  for(const name of names){indexPush(personNameIndex,normalize(name),person);indexPush(firstNameIndex,normalize(name).split(' ')[0],person)}
  if(person.club_name){indexPush(clubNameIndex,normalize(person.club_name),person);indexPush(clubCoreIndex,normalize(person.club_name).replace(/^(broder|syster|s)\s+/,'').trim(),person)}
}
const historicalPersonIndex=new Map();
for(const entity of historicalState.listEntities('person-occurrence')){const item=entity.fields;if(item.person_id&&item.confirmed)indexPush(historicalPersonIndex,normalize(item.person_name_raw),item.person_id)}
function birthCompatible(person,birthYear){return !birthYear||!person.birth||Number(person.birth)===Number(birthYear)}
function personMatch(item){
  const exact=unique((personNameIndex.get(normalize(item.person_name_raw))||[]).filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id));
  if(exact.length===1)return {person_id:exact[0],match_status:'kopplad',match_method:'exakt personnamn',candidate_ids:exact,confirmed:true};
  const historical=unique(historicalPersonIndex.get(normalize(item.person_name_raw))||[]);
  if(historical.length===1)return {person_id:historical[0],match_status:'godkand',match_method:'tidigare källbelagd personidentitet',candidate_ids:historical,confirmed:true};
  const club=item.club_name_raw?unique((clubNameIndex.get(normalize(item.club_name_raw))||[]).filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id)):[];
  if(club.length===1)return {person_id:club[0],match_status:'kopplad',match_method:'exakt klubbnamn',candidate_ids:club,confirmed:true};
  const core=item.club_name_core_raw?unique((clubCoreIndex.get(normalize(item.club_name_core_raw))||[]).filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id)):[];
  if(core.length===1)return {person_id:core[0],match_status:'kopplad',match_method:'exakt klubbnamnskärna',candidate_ids:core,confirmed:true};
  const first=normalize(item.person_name_raw).split(' ')[0];
  const candidates=unique([...(personNameIndex.get(normalize(item.person_name_raw))||[]),...(firstNameIndex.get(first)||[])].filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id));
  return {person_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates.slice(0,12),confirmed:false};
}

function boatAliases(boat){const raw=[boat.namn,boat.dopnamn,boat.onskat_namn,...array(boat.smeknamn),...array(boat.tidigare_namn),...array(boat.senare_namn)];return unique(raw.flatMap(value=>String(value||'').split(/\/|\balias\b|\sa\.\s/i)).map(compact))}
const boatsById=new Map(boats.map(boat=>[boat.id,boat]));const boatIndex=new Map();
for(const boat of boats)for(const alias of boatAliases(boat))indexPush(boatIndex,alias,boat);
const historicalBoatIndex=new Map();
for(const entity of historicalState.listEntities('boat-occurrence')){const item=entity.fields;if(item.boat_id&&item.confirmed)indexPush(historicalBoatIndex,`${item.prefix||''}:${compact(item.boat_name_raw)}`,item.boat_id)}
function confirmedBoat(boatId,method){if(!boatsById.has(boatId))throw new Error(`Båten ${boatId} saknas i referensen.`);return {boat_id:boatId,match_status:'godkand',match_method:method,candidate_ids:[boatId],confirmed:true}}
function boatMatch(item){
  const nameKey=compact(item.boat_name_raw);const historical=unique(historicalBoatIndex.get(`${item.prefix}:${nameKey}`)||[]);
  if(historical.length===1)return confirmedBoat(historical[0],'tidigare källbelagd båtidentitet');
  const keys=unique([item.boat_name_raw,...String(item.boat_name_raw||'').split(/\balias\b|\sa\.\s/i)].map(compact));
  const exactBoats=unique(keys.flatMap(value=>boatIndex.get(value)||[]).map(boat=>boat.id));
  if(exactBoats.length===1)return {boat_id:exactBoats[0],match_status:'kopplad',match_method:'exakt namn eller alias',candidate_ids:exactBoats,confirmed:true};
  if(exactBoats.length>1&&item.prefix){const typeCompatible=exactBoats.filter(id=>normalize(boatsById.get(id)?.typ||boatsById.get(id)?.type).includes(normalize(item.prefix)));if(typeCompatible.length===1)return {boat_id:typeCompatible[0],match_status:'kopplad',match_method:'entydigt namn och fartygstyp',candidate_ids:typeCompatible,confirmed:true}}
  const candidates=exactBoats.length?exactBoats:unique([...boatIndex.entries()].filter(([alias])=>nameKey.length>=4&&alias.length>=4&&(alias.includes(nameKey)||nameKey.includes(alias))).flatMap(([,values])=>values.map(boat=>boat.id))).slice(0,12);
  return {boat_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates,confirmed:false};
}

function entityList(type){return historicalState.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}))}
const existingPeopleByRelease=new Map();const existingBoatsByRelease=new Map();
for(const item of entityList('person-occurrence'))indexPush(existingPeopleByRelease,item.release_id,{...item,used:false});
for(const item of entityList('boat-occurrence'))indexPush(existingBoatsByRelease,item.release_id,{...item,used:false});
function takeExistingPerson(releaseId,row){
  const pool=existingPeopleByRelease.get(releaseId)||[];const raw=normalize(row.raw_text);const name=normalize(row.person_name_raw);
  let match=pool.find(item=>!item.used&&normalize(item.raw_text)===raw&&item.membership_status===row.category);
  if(!match)match=pool.find(item=>!item.used&&normalize(item.person_name_raw)===name&&item.membership_status===row.category&&(item.induction_year_raw||'')===(row.induction_year_raw||''));
  if(match)match.used=true;return match||null;
}
function takeExistingBoat(releaseId,row,component){
  const pool=existingBoatsByRelease.get(releaseId)||[];const name=compact(component.boat_name_raw);
  let match=pool.find(item=>!item.used&&normalize(item.raw_text)===normalize(component.raw_text)&&normalize(item.source_line_raw)===normalize(row.raw_text));
  if(!match)match=pool.find(item=>!item.used&&compact(item.boat_name_raw)===name&&(item.prefix||'')===component.prefix&&(!item.source_category||item.source_category===row.category));
  if(match)match.used=true;return match||null;
}

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push({op_id:`${DEVICE}:${seq}`,device_id:DEVICE,seq,entity_type:entityType,entity_id:entityId,field,value:value===undefined?null:value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`,schema_version:1})}
function add(type,item){const {id,...fields}=item;for(const [field,value] of Object.entries(fields))set(type,id,field,value)}

for(const source of sourceDocuments){
  const document=source.json;
  add('source-document',{id:document.document.id,label:document.document.label,private_copy:`privat/kallkopior/matriklar/${source.file}`,sha256:sha256(source.bytes),source_type:document.document.source_type,source_file_hashes:Object.fromEntries(document.document.original_files.map(file=>[file.original_filename,file.sha256])),source_file_count:document.document.original_files.length,is_primary_for_release:document.document.is_primary_for_release,release_id:document.release.id,sort_order:document.release.sort_order,immutable:true,schema_version:document.schema_version});
}

const releases=[];const sourceRows=[];const newPeople=[];const newBoats=[];const reusedPeople=[];const reusedBoats=[];
for(const source of primaryDocuments){
  const document=source.json;const release=document.release;const releaseId=release.id;const sourceDocumentIds=sourceDocuments.filter(item=>item.json.release.id===releaseId).map(item=>item.json.document.id);
  let personOccurrenceCount=0;let boatOccurrenceCount=0;
  for(const row of document.member_rows){
    const rowId=`source-row:canonical:${document.document.id}:member:${pad(row.order)}`;const occurrenceIds=[];
    if(row.category!=='blank'&&row.person_name_raw){
      personOccurrenceCount+=1;const existing=takeExistingPerson(releaseId,row);
      if(existing){occurrenceIds.push(existing.id);reusedPeople.push(existing.id);set('person-occurrence',existing.id,'canonical_source_row_id',rowId);if(!existing.source_page&&row.page)set('person-occurrence',existing.id,'source_page',row.page)}
      else{
        const id=`person-occurrence:${releaseId}:canonical:${pad(row.order)}`;
        const item={id,release_id:releaseId,source_document_id:document.document.id,source_row_id:rowId,order:row.order,raw_text:row.raw_text,source_page:row.page,source_annotation:row.source_annotation,person_name_raw:row.person_name_raw,club_name_core_raw:row.club_name_core_raw,membership_status:row.category,induction_year_raw:row.induction_year_raw,induction_year:row.induction_year,age_raw:row.age_raw,birth_year:row.birth_year,birth_date_raw:row.birth_date_raw,birth_date:row.birth_date,island_raw:row.island_raw,club_name_raw:row.club_name_raw,relation_raw:row.relation_raw,...personMatch(row)};
        newPeople.push(item);add('person-occurrence',item);occurrenceIds.push(id);
      }
    }
    const sourceRow={id:rowId,release_id:releaseId,source_document_id:document.document.id,kind:'person',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,occurrence_ids:occurrenceIds};sourceRows.push(sourceRow);add('source-row',sourceRow);
  }
  for(const row of document.boat_rows){
    const rowId=`source-row:canonical:${document.document.id}:boat:${pad(row.order)}`;const occurrenceIds=[];
    for(const component of row.components){
      boatOccurrenceCount+=1;const existing=takeExistingBoat(releaseId,row,component);
      if(existing){occurrenceIds.push(existing.id);reusedBoats.push(existing.id);set('boat-occurrence',existing.id,'canonical_source_row_id',rowId);if(!existing.source_page&&row.page)set('boat-occurrence',existing.id,'source_page',row.page)}
      else{
        const id=`boat-occurrence:${releaseId}:canonical:${pad(row.order)}:${component.order}`;
        const item={id,release_id:releaseId,source_document_id:document.document.id,source_row_id:rowId,order:boatOccurrenceCount,source_line_order:row.order,component_order:component.order,source_page:row.page,source_category:row.category,source_annotation:row.source_annotation,raw_text:component.raw_text,source_line_raw:row.raw_text,prefix:component.prefix,boat_name_raw:component.boat_name_raw,registry_year_raw:component.registry_year_raw,registry_year:component.registry_year,registry_years:component.registry_years,...boatMatch(component)};
        newBoats.push(item);add('boat-occurrence',item);occurrenceIds.push(id);
      }
    }
    const sourceRow={id:rowId,release_id:releaseId,source_document_id:document.document.id,kind:'boat',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,occurrence_ids:occurrenceIds};sourceRows.push(sourceRow);add('source-row',sourceRow);
  }
  const personCategories=Object.fromEntries([...new Set(document.member_rows.map(row=>row.category))].map(category=>[category,document.member_rows.filter(row=>row.category===category).length]));
  const boatCategories=Object.fromEntries([...new Set(document.boat_rows.map(row=>row.category))].map(category=>[category,document.boat_rows.filter(row=>row.category===category).length]));
  const item={id:releaseId,...release,source_document_id:document.document.id,source_document_ids:sourceDocumentIds,person_row_count:personOccurrenceCount,person_category_counts:personCategories,boat_source_row_count:document.boat_rows.length,boat_occurrence_count:boatOccurrenceCount,boat_category_counts:boatCategories,canonical_schema_version:document.schema_version};
  releases.push(item);add('matrikel-release',item);
}

const releaseIds=releases.slice().sort((a,b)=>a.as_of.localeCompare(b.as_of)||a.title.localeCompare(b.title,'sv')||a.id.localeCompare(b.id,'sv')).map(release=>release.id);
const root=historicalState.getEntity('club-history-root','club-history-root:kbk')?.fields||{};
set('club-history-root','club-history-root:kbk','release_ids',unique([...releaseIds,...array(root.release_ids).filter(id=>!releaseIds.includes(id))]));
set('club-history-root','club-history-root:kbk','canonical_source_hashes',Object.fromEntries(sourceDocuments.map(source=>[source.json.document.id,sha256(source.bytes)])));
set('club-history-root','club-history-root:kbk','canonical_schema_version',1);

const finalState=materialize([...baseDocument.operations,...correctionOperations,...operations]);
const finalPeople=finalState.listEntities('person-occurrence').map(entity=>entity.fields);const finalBoats=finalState.listEntities('boat-occurrence').map(entity=>entity.fields);
const releaseCounts=Object.fromEntries(releases.map(release=>[release.id,{person_occurrences:finalPeople.filter(item=>item.release_id===release.id).length,boat_occurrences:finalBoats.filter(item=>item.release_id===release.id).length,new_person_occurrences:newPeople.filter(item=>item.release_id===release.id).length,reused_person_occurrences:reusedPeople.filter(id=>finalState.getEntity('person-occurrence',id)?.fields.release_id===release.id).length,new_boat_occurrences:newBoats.filter(item=>item.release_id===release.id).length,reused_boat_occurrences:reusedBoats.filter(id=>finalState.getEntity('boat-occurrence',id)?.fields.release_id===release.id).length}]));
const unresolvedPeople=newPeople.filter(item=>!item.person_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.person_name_raw,status:item.match_status,candidate_ids:item.candidate_ids}));
const unresolvedBoats=newBoats.filter(item=>!item.boat_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.boat_name_raw,status:item.match_status,candidate_ids:item.candidate_ids}));
const counts={source_documents:sourceDocuments.length,releases:releases.length,source_rows:sourceRows.length,new_person_occurrences:newPeople.length,reused_person_occurrences:reusedPeople.length,new_boat_occurrences:newBoats.length,reused_boat_occurrences:reusedBoats.length,unresolved_new_people:unresolvedPeople.length,unresolved_new_boats:unresolvedBoats.length,operations:operations.length};
const document={operations_version:1,migration_id:'klubbhistorik-synkade-matriklar-2026-08-03',device_id:DEVICE,operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),counts,operations};
const report={generated_on:'2026-08-03',contract:'Källrader och sorteringsvarianter bevaras; befintliga identitetsbeslut skrivs inte över.',release_counts:releaseCounts,counts,unresolved_people:unresolvedPeople,unresolved_boats:unresolvedBoats};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(document,null,2)}\n`);
await writeFile(REPORT_PATH,`${JSON.stringify(report,null,2)}\n`);
console.log(`Synkad matrikelimport: ${releases.length} utgåvor, ${newPeople.length} nya medlemsförekomster, ${newBoats.length} nya båtförekomster och ${reusedPeople.length+reusedBoats.length} återanvända befintliga förekomster.`);
