import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const SOURCES=resolve(PRIVATE,'kallkopior');
const OUT=resolve(PRIVATE,'migrering-2026-08-02');
const PATHS={
  historic:resolve(SOURCES,'matriklar-1980-1986.md'),
  current:resolve(SOURCES,'vem-ar-vem-2025.txt'),
  people:resolve(SOURCES,'matrikel-initial-archive.json'),
  boats:resolve(SOURCES,'batregister-initial-ops.json'),
  decisions:resolve(SOURCES,'godkanda-personmatchningar.json'),
};
const DEVICE='migration-klubbhistorik-2026-08-02';
const DECISION_DEVICE='migration-klubbhistorik-beslut-2026-08-02';
const CLOCK_MS=Date.UTC(2026,7,2,21,0,0);
const ISLANDS=new Set(['Korpholmen','Sviholmen','Ängsholmen','Blidö','Svanö']);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>normalize(value).replaceAll(' ','');
const unique=values=>[...new Set(values.filter(Boolean))];
const array=value=>Array.isArray(value)?value:value?[value]:[];
const sourceBytes=Object.fromEntries(await Promise.all(Object.entries(PATHS).map(async([key,path])=>[key,await readFile(path)])));
const sourceHashes=Object.fromEntries(Object.entries(sourceBytes).map(([key,value])=>[key,sha256(value)]));
const historicText=sourceBytes.historic.toString('utf8');
const currentText=sourceBytes.current.toString('utf8');
const peopleArchive=JSON.parse(sourceBytes.people.toString('utf8'));
const boatOperations=JSON.parse(sourceBytes.boats.toString('utf8'));
const decisions=JSON.parse(sourceBytes.decisions.toString('utf8'));

if(decisions.version!==1||!Array.isArray(decisions.decisions))throw new Error('Godkända personmatchningar har fel format.');
if(!Array.isArray(peopleArchive.persons))throw new Error('Matrikelarkivet saknar personer.');
const people=peopleArchive.persons.map(person=>({id:person.id,...person.fields}));
const boatState=materialize(boatOperations.operations);
const boats=boatState.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));

function sectionForYear(year){
  const marker=`### MATR-${year}`;
  const start=historicText.indexOf(marker);
  if(start<0)throw new Error(`MATR-${year} saknas i källkopian.`);
  const next=historicText.indexOf('### MATR-',start+marker.length);
  return historicText.slice(start,next<0?historicText.length:next);
}
function codeBlockAfter(text,marker){
  const start=text.indexOf(marker);
  if(start<0)throw new Error(`Källmarkör saknas: ${marker}`);
  const fence=text.indexOf('```',start+marker.length);
  const end=text.indexOf('```',fence+3);
  if(fence<0||end<0)throw new Error(`Kodblock saknas efter: ${marker}`);
  return text.slice(fence+3,end).replace(/^\s*\n/,'').split('\n').filter(line=>line.trim());
}
function historicName(raw){
  const text=String(raw||'').trim();
  const leading=text.match(/^\(([^)]+)-\)\s+([^\s]+)(?:\s+(.+))?$/);
  const trailing=text.match(/^([^\s]+)\s+\(-([^)]+)\)(?:\s+(.+))?$/);
  let clubCore='';
  if(leading)clubCore=`${leading[1]}-${leading[2]}`;
  if(trailing)clubCore=`${trailing[1]}-${trailing[2]}`;
  const personName=text.replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
  return {personName,clubCore};
}
function parseHistoricMemberLine(raw,releaseId,status,index){
  const match=String(raw).match(/^\s*(?:(\d{4}\??)\s+)?(.+?)\s*$/);
  if(!match)throw new Error(`Ogiltig medlemsrad ${releaseId}:${index+1}`);
  const parsed=historicName(match[2]);
  return {
    id:`person-occurrence:${releaseId}:${String(index+1).padStart(3,'0')}`,
    release_id:releaseId,
    order:index+1,
    raw_text:raw,
    person_name_raw:parsed.personName,
    club_name_core_raw:parsed.clubCore,
    membership_status:status,
    induction_year_raw:match[1]||'',
    induction_year:/^\d{4}$/.test(match[1]||'')?Number(match[1]):null,
    birth_year:null,
    birth_date_raw:'',
    island_raw:'',
    club_name_raw:'',
  };
}
function splitOutsideParentheses(value){
  const parts=[];let depth=0;let start=0;
  for(let index=0;index<value.length;index+=1){
    if(value[index]==='(')depth+=1;
    if(value[index]===')')depth=Math.max(0,depth-1);
    if(value[index]===','&&depth===0){parts.push(value.slice(start,index).trim());start=index+1}
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}
function parseBoatComponent(raw){
  const prefix=raw.match(/^(M\/S|S\/S|R\/S)\s+/i)?.[1]?.toUpperCase()||'';
  let name=raw.replace(/^(?:M\/S|S\/S|R\/S)\s+/i,'').trim();
  const yearMatch=name.match(/\s+\((\d{2,4})\)$/);
  const registryYearRaw=yearMatch?.[1]||'';
  if(yearMatch)name=name.slice(0,yearMatch.index).trim();
  return {prefix,boat_name_raw:name,registry_year_raw:registryYearRaw,registry_year:/^\d{4}$/.test(registryYearRaw)?Number(registryYearRaw):null};
}
function validBirthDate(raw,birthYear){
  if(!/^\d{8}$/.test(raw)||Number(raw.slice(0,4))!==birthYear)return null;
  const year=Number(raw.slice(0,4));const month=Number(raw.slice(4,6));const day=Number(raw.slice(6,8));
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`:null;
}
function parseCurrentMembers(){
  const lines=currentText.split('\n');const rows=[];
  for(let index=0;index<lines.length;index+=1){
    const raw=lines[index].replace(/\s+$/,'');
    const parts=raw.trim().split(/\s{2,}/);
    if(!/^\d{1,3}$/.test(parts[0]||'')||!parts.slice(1).some(part=>/^\d{4}$/.test(part)))continue;
    const yearIndex=parts.findIndex((part,partIndex)=>partIndex>0&&/^\d{4}$/.test(part));
    if(yearIndex<3)throw new Error(`2025-raden kan inte delas i namn och födelseår: ${raw}`);
    const age=Number(parts[0]);const firstName=parts.slice(1,yearIndex-1).join(' ');const lastName=parts[yearIndex-1];const birthYear=Number(parts[yearIndex]);
    const tail=parts.slice(yearIndex+1);let birthDateRaw='';let islandRaw='';let clubNameRaw='';
    if(tail[0]){
      const joined=tail[0].match(/^(\d{8,9})\s+(Korpholmen|Sviholmen|Ängsholmen|Blidö|Svanö)$/);
      if(joined)tail.splice(0,1,joined[1],joined[2]);
    }
    if(tail[0]&&/^\d{8,9}$/.test(tail[0]))birthDateRaw=tail.shift();
    if(tail[0]&&ISLANDS.has(tail[0]))islandRaw=tail.shift();
    clubNameRaw=tail.join(' ');
    let rawText=raw;
    if(clubNameRaw.endsWith('-')){
      const continuation=String(lines[index+1]||'').trim();
      if(continuation&&/^[\p{L}]/u.test(continuation)){clubNameRaw+=continuation;rawText+=`\n${lines[index+1].replace(/\s+$/,'')}`;index+=1}
    }
    rows.push({
      id:`person-occurrence:matrikel-2025:${String(rows.length+1).padStart(3,'0')}`,
      release_id:'matrikel-2025',
      order:rows.length+1,
      raw_text:rawText,
      person_name_raw:`${firstName} ${lastName}`.replace(/\s+/g,' ').trim(),
      club_name_core_raw:'',
      membership_status:'listed',
      induction_year_raw:'',
      induction_year:null,
      age_raw:String(age),
      birth_year:birthYear,
      birth_date_raw:birthDateRaw,
      birth_date:validBirthDate(birthDateRaw,birthYear),
      island_raw:islandRaw,
      club_name_raw:clubNameRaw,
    });
  }
  return rows;
}

const personNameIndex=new Map();const firstNameIndex=new Map();const clubNameIndex=new Map();const clubCoreIndex=new Map();
function indexPush(index,key,person){if(!key)return;if(!index.has(key))index.set(key,[]);index.get(key).push(person)}
for(const person of people){
  const names=unique([person.display_name,person.full_name,person.birth_name,...array(person.aliases)]);
  for(const name of names){indexPush(personNameIndex,normalize(name),person);indexPush(firstNameIndex,normalize(name).split(' ')[0],person)}
  if(person.club_name){
    indexPush(clubNameIndex,normalize(person.club_name),person);
    indexPush(clubCoreIndex,normalize(person.club_name).replace(/^(broder|syster|s)\s+/,'').trim(),person);
  }
}
function birthCompatible(person,birthYear){return !birthYear||!person.birth||Number(person.birth)===Number(birthYear)}
function personMatch(item){
  const exact=unique((personNameIndex.get(normalize(item.person_name_raw))||[]).filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id));
  if(exact.length===1)return {person_id:exact[0],match_status:'kopplad',match_method:'exakt personnamn',candidate_ids:exact,confirmed:true};
  const club=item.club_name_raw?clubNameIndex.get(normalize(item.club_name_raw))||[]:[];
  const clubCompatible=unique(club.filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id));
  if(clubCompatible.length===1)return {person_id:clubCompatible[0],match_status:'kopplad',match_method:'exakt klubbnamn',candidate_ids:clubCompatible,confirmed:true};
  const core=item.club_name_core_raw?clubCoreIndex.get(normalize(item.club_name_core_raw))||[]:[];
  const coreCompatible=unique(core.filter(person=>birthCompatible(person,item.birth_year)).map(person=>person.id));
  if(coreCompatible.length===1)return {person_id:coreCompatible[0],match_status:'kopplad',match_method:'exakt klubbnamnskärna',candidate_ids:coreCompatible,confirmed:true};
  const first=normalize(item.person_name_raw).split(' ')[0];
  const candidates=unique([...(personNameIndex.get(normalize(item.person_name_raw))||[]),...(firstNameIndex.get(first)||[])].map(person=>person.id));
  return {person_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates.slice(0,12),confirmed:false};
}

function boatAliases(boat){
  const raw=[boat.namn,boat.dopnamn,boat.onskat_namn,...array(boat.smeknamn),...array(boat.tidigare_namn),...array(boat.senare_namn)];
  return unique(raw.flatMap(value=>String(value||'').split(/\/|\balias\b/i)).map(compact));
}
const boatIndex=new Map();
for(const boat of boats)for(const alias of boatAliases(boat))indexPush(boatIndex,alias,boat);
function boatMatch(item){
  const keys=unique([item.boat_name_raw,...String(item.boat_name_raw||'').split(/\balias\b/i)].map(compact));
  const key=keys[0];const exact=unique(keys.flatMap(value=>(boatIndex.get(value)||[]).map(boat=>boat.id)));
  if(exact.length===1)return {boat_id:exact[0],match_status:'kopplad',match_method:'exakt namn eller alias',candidate_ids:exact,confirmed:true};
  const candidates=unique([...boatIndex.entries()].filter(([alias])=>key.length>=4&&alias.length>=4&&(alias.includes(key)||key.includes(alias))).flatMap(([,values])=>values.map(boat=>boat.id))).slice(0,12);
  return {boat_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnlikhet':'ingen träff',candidate_ids:candidates,confirmed:false};
}

const releases=[];const sourceRows=[];const personOccurrences=[];const boatOccurrences=[];
for(const year of [1980,1986]){
  const releaseId=`matrikel-${year}`;const section=sectionForYear(year);
  const activeLines=codeBlockAfter(section,'Namnkolumn');
  const passiveLines=year===1980?codeBlockAfter(section,'**ORDINARIE PASSIVA MEDL.**'):[];
  const boatLines=codeBlockAfter(section,'Fartygskolumn');
  if(year===1980)boatLines.push(...codeBlockAfter(section,'Längst ned i fartygskolumnen'));
  const members=[...activeLines.map((line,index)=>parseHistoricMemberLine(line,releaseId,'active',index)),...passiveLines.map((line,index)=>parseHistoricMemberLine(line,releaseId,'passive',activeLines.length+index))];
  for(const item of members){
    const match=personMatch(item);Object.assign(item,match);personOccurrences.push(item);
    sourceRows.push({id:`source-row:${item.id}`,release_id:releaseId,kind:'person',order:item.order,raw_text:item.raw_text,occurrence_ids:[item.id]});
  }
  boatLines.forEach((line,lineIndex)=>{
    const rowId=`source-row:${releaseId}:boat:${String(lineIndex+1).padStart(3,'0')}`;const occurrenceIds=[];
    splitOutsideParentheses(line).forEach((component,componentIndex)=>{
      const parsed=parseBoatComponent(component);const id=`boat-occurrence:${releaseId}:${String(lineIndex+1).padStart(3,'0')}:${componentIndex+1}`;
      const match=boatMatch(parsed);boatOccurrences.push({id,release_id:releaseId,source_row_id:rowId,order:boatOccurrences.filter(item=>item.release_id===releaseId).length+1,source_line_order:lineIndex+1,component_order:componentIndex+1,raw_text:component,source_line_raw:line,...parsed,...match});occurrenceIds.push(id);
    });
    sourceRows.push({id:rowId,release_id:releaseId,kind:'boat',order:lineIndex+1,raw_text:line,occurrence_ids:occurrenceIds});
  });
  releases.push({id:releaseId,year,as_of:`${year}-07`,title:`Medlemsmatrikel juli ${year}`,source_document_id:'source-document:matriklar-1980-1986',person_row_count:members.length,boat_source_row_count:boatLines.length,boat_occurrence_count:boatOccurrences.filter(item=>item.release_id===releaseId).length,sort_order:'källordning',release_type:'medlemsmatrikel'});
}
const currentMembers=parseCurrentMembers();
for(const item of currentMembers){const match=personMatch(item);Object.assign(item,match);personOccurrences.push(item);sourceRows.push({id:`source-row:${item.id}`,release_id:item.release_id,kind:'person',order:item.order,raw_text:item.raw_text,occurrence_ids:[item.id]})}
releases.push({id:'matrikel-2025',year:2025,as_of:'2025',title:'Vem är vem? – uppdaterad 2025',source_document_id:'source-document:vem-ar-vem-2025',person_row_count:currentMembers.length,boat_source_row_count:0,boat_occurrence_count:0,sort_order:'ålder',release_type:'vem-ar-vem'});

const peopleById=new Map(people.map(person=>[person.id,person]));
for(const decision of decisions.decisions){
  if(!peopleById.has(decision.person_id))throw new Error(`Godkänt beslut pekar på okänd person: ${decision.person_id}`);
  const matches=personOccurrences.filter(item=>item.release_id===decision.release_id&&item.person_name_raw===decision.raw_name);
  if(matches.length!==1)throw new Error(`Godkänt beslut måste träffa exakt en rad: ${decision.release_id} / ${decision.raw_name} (${matches.length})`);
  matches[0].approved_decision=decision;
}

let seq=0;let decisionSeq=0;const operations=[];
function operation(device,sequence,entityType,entityId,field,value,offset=0){return {op_id:`${device}:${sequence}`,device_id:device,seq:sequence,entity_type:entityType,entity_id:entityId,field,value:value===undefined?null:value,hlc:`${CLOCK_MS+offset}-${String(sequence).padStart(6,'0')}-${device}`,schema_version:1}}
function set(entityType,entityId,field,value){seq+=1;operations.push(operation(DEVICE,seq,entityType,entityId,field,value))}
function decisionSet(entityType,entityId,field,value){decisionSeq+=1;operations.push(operation(DECISION_DEVICE,decisionSeq,entityType,entityId,field,value,60_000))}
function add(type,item){const {id,...fields}=item;for(const [field,value] of Object.entries(fields))set(type,id,field,value)}

add('source-document',{id:'source-document:matriklar-1980-1986',label:'Matriklarna 1980 och 1986 – avskrift',private_copy:'privat/kallkopior/matriklar-1980-1986.md',sha256:sourceHashes.historic,source_type:'ordagrann avskrift',immutable:true});
add('source-document',{id:'source-document:vem-ar-vem-2025',label:'Vem är vem 2025 – Numbers-export, textextrakt',private_copy:'privat/kallkopior/vem-ar-vem-2025.txt',sha256:sourceHashes.current,source_type:'PDF-textextrakt',immutable:true});
for(const release of releases)add('matrikel-release',release);
for(const row of sourceRows)add('source-row',row);
for(const item of personOccurrences){
  const {approved_decision,...rawItem}=item;add('person-occurrence',rawItem);
  if(approved_decision){
    decisionSet('person-occurrence',item.id,'person_id',approved_decision.person_id);
    decisionSet('person-occurrence',item.id,'match_status','godkand');
    decisionSet('person-occurrence',item.id,'match_method','tidigare godkänt identitetsbeslut');
    decisionSet('person-occurrence',item.id,'candidate_ids',[approved_decision.person_id]);
    decisionSet('person-occurrence',item.id,'confirmed',true);
    decisionSet('person-occurrence',item.id,'decision_note',approved_decision.reason);
  }
}
for(const item of boatOccurrences)add('boat-occurrence',item);
for(const person of people)add('person-ref',{id:`person-ref:${person.id}`,external_id:person.id,display_name:person.display_name,full_name:person.full_name||'',birth_name:person.birth_name||'',birth:person.birth||null,club_name:person.club_name||'',aliases:array(person.aliases),url:`../matrikel/?person=${encodeURIComponent(person.id)}`});
for(const boat of boats)add('boat-ref',{id:`boat-ref:${boat.id}`,external_id:boat.id,name:boat.namn||'',aliases:unique([boat.dopnamn,boat.onskat_namn,...array(boat.smeknamn),...array(boat.tidigare_namn),...array(boat.senare_namn)]),url:`../batregister/?boat=${encodeURIComponent(boat.id)}`});
for(const [index,change] of decisions.historical_name_changes.entries())add('name-change-candidate',{id:`name-change-candidate:${String(index+1).padStart(3,'0')}`,...change,status:'belagd kandidat',writes_to_person_master:false});
add('club-history-root',{id:'club-history-root:kbk',schema_version:1,migration_id:'klubbhistorik-pilot-2026-08-02',release_ids:releases.map(item=>item.id),source_hashes:sourceHashes,person_reference_count:people.length,boat_reference_count:boats.length});

const state=materialize(operations);
const list=type=>state.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const finalPeople=list('person-occurrence');const finalBoats=list('boat-occurrence');
const duplicateGroups=[];
for(const release of releases){
  const byPerson=new Map();
  for(const item of finalPeople.filter(entry=>entry.release_id===release.id&&entry.person_id&&entry.confirmed)){
    if(!byPerson.has(item.person_id))byPerson.set(item.person_id,[]);byPerson.get(item.person_id).push(item);
  }
  for(const [personId,items] of byPerson)if(items.length>1)duplicateGroups.push({release_id:release.id,person_id:personId,occurrence_ids:items.map(item=>item.id),raw_names:items.map(item=>item.person_name_raw)});
}
const invalidBirthDates=finalPeople.filter(item=>item.birth_date_raw&&!item.birth_date).map(item=>({occurrence_id:item.id,raw:item.birth_date_raw,birth_year:item.birth_year}));
const unresolvedPeople=finalPeople.filter(item=>!item.person_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.person_name_raw,status:item.match_status,candidate_ids:item.candidate_ids}));
const unresolvedBoats=finalBoats.filter(item=>!item.boat_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.boat_name_raw,status:item.match_status,candidate_ids:item.candidate_ids}));
const releaseCounts=Object.fromEntries(releases.map(release=>[release.id,{person_rows:finalPeople.filter(item=>item.release_id===release.id).length,boat_source_rows:list('source-row').filter(item=>item.release_id===release.id&&item.kind==='boat').length,boat_occurrences:finalBoats.filter(item=>item.release_id===release.id).length,connected_person_rows:finalPeople.filter(item=>item.release_id===release.id&&item.person_id&&item.confirmed).length,unresolved_person_rows:finalPeople.filter(item=>item.release_id===release.id&&(!item.person_id||!item.confirmed)).length}]))
const operationsSha256=sha256(Buffer.from(JSON.stringify(operations)));
const counts={releases:releases.length,source_rows:sourceRows.length,person_occurrences:finalPeople.length,boat_occurrences:finalBoats.length,people:people.length,boats:boats.length,confirmed_person_occurrences:finalPeople.filter(item=>item.person_id&&item.confirmed).length,unresolved_people:unresolvedPeople.length,confirmed_boat_occurrences:finalBoats.filter(item=>item.boat_id&&item.confirmed).length,unresolved_boats:unresolvedBoats.length,duplicate_person_groups:duplicateGroups.length,invalid_birth_dates:invalidBirthDates.length,operations:operations.length};
const document={operations_version:1,migration_id:'klubbhistorik-pilot-2026-08-02',device_id:DEVICE,device_ids:[DEVICE,DECISION_DEVICE],operations_sha256:operationsSha256,source_hashes:sourceHashes,counts,operations};
const report={generated_on:'2026-08-02',contract:'Ingen källrad får försvinna; osäkra identiteter får inte godkännas tyst.',source_hashes:sourceHashes,release_counts:releaseCounts,counts,duplicate_person_groups:duplicateGroups,invalid_birth_dates:invalidBirthDates,unresolved_people:unresolvedPeople,unresolved_boats:unresolvedBoats,name_change_candidates:decisions.historical_name_changes};
await mkdir(OUT,{recursive:true});
await writeFile(resolve(OUT,'initial-ops.json'),`${JSON.stringify(document,null,2)}\n`);
await writeFile(resolve(OUT,'kontrollrapport.json'),`${JSON.stringify(report,null,2)}\n`);
console.log(`Klubbhistorik byggd: ${finalPeople.length} medlemsrader, ${finalBoats.length} båtförekomster, ${unresolvedPeople.length} personrader och ${unresolvedBoats.length} båtar till granskning.`);
