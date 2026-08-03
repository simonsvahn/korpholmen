import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const SOURCE_PATH=resolve(PRIVATE,'kallkopior/matriklar-1991-1998.json');
const PEOPLE_PATH=resolve(PRIVATE,'kallkopior/matrikel-initial-archive.json');
const BOATS_PATH=resolve(PRIVATE,'kallkopior/batregister-initial-ops.json');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const OUT_PATH=resolve(PRIVATE,'korrigeringar/2026-08-03-matriklar-1991-1998.json');
const REPORT_PATH=resolve(PRIVATE,'migrering-2026-08-02/kontrollrapport-1991-1998.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-03-matriklar-1991-1998.json';
const DEVICE='ingest-klubbhistorik-matriklar-1991-1998-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,3,14,0,0);
const STATUS_ORDER=['active','passive','junior','corresponding'];

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>normalize(value).replaceAll(' ','');
const unique=values=>[...new Set(values.filter(Boolean))];
const array=value=>Array.isArray(value)?value:value?[value]:[];
const [sourceBytes,peopleBytes,boatBytes,baseBytes]=await Promise.all([
  readFile(SOURCE_PATH),readFile(PEOPLE_PATH),readFile(BOATS_PATH),readFile(BASE_PATH),
]);
const source=JSON.parse(sourceBytes);
const peopleArchive=JSON.parse(peopleBytes);
const boatOperations=JSON.parse(boatBytes);
const baseDocument=JSON.parse(baseBytes);
const priorCorrectionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort();
const priorCorrectionDocuments=await Promise.all(priorCorrectionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const priorCorrectionOperations=priorCorrectionDocuments.flatMap(document=>document.operations||document.ops||[]);
const baseState=materialize(baseDocument.operations);
const historicalState=materialize([...baseDocument.operations,...priorCorrectionOperations]);

if(source.version!==1||!Array.isArray(source.releases)||source.releases.length!==2)throw new Error('Tilläggsmatriklarna har fel format.');
if(!Array.isArray(source.source_files)||source.source_files.length!==6)throw new Error('De sex källbilderna måste vara bokförda.');
if(!Array.isArray(peopleArchive.persons))throw new Error('Matrikelarkivet saknar personer.');
const sourceFileKeys=new Set();
for(const file of source.source_files){
  if(!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error(`Ogiltig källhash: ${file.filename}`);
  const key=`${file.year}:${file.page}`;
  if(sourceFileKeys.has(key))throw new Error(`Dubbel källsida: ${key}`);
  sourceFileKeys.add(key);
}

const people=peopleArchive.persons.map(person=>({id:person.id,...person.fields}));
const boatState=materialize(boatOperations.operations);
const boats=boatState.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));

function historicName(raw){
  const text=String(raw||'').trim();
  const leading=text.match(/^\(([^)]+?)[-–—]\)\s*([^\s]+)(?:\s+(.+))?$/);
  const trailing=text.match(/^([^\s(]+)\s*\(\s*[-–—]([^)]+)\)\s*(.*)$/);
  let clubCore='';
  if(leading)clubCore=`${leading[1]}-${leading[2]}`;
  if(trailing)clubCore=`${trailing[1]}-${trailing[2]}`;
  const personName=text.replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
  return {personName,clubCore};
}

function pageForPerson(release,status,index){
  let remaining=index;
  for(const span of release.people_pages?.[status]||[]){
    if(remaining<span.count)return span.page;
    remaining-=span.count;
  }
  throw new Error(`Sidindelning saknas: ${release.id}/${status}/${index+1}`);
}

function parseMemberLine(raw,release,status,index,order){
  const match=String(raw).match(/^\s*(?:(\d{4}\??)\s+)?(.+?)\s*$/);
  if(!match)throw new Error(`Ogiltig medlemsrad ${release.id}:${order}`);
  const parsed=historicName(match[2]);
  const annotation=release.people_annotations?.find(item=>item.raw_text===raw)?.annotation||'';
  return {
    id:`person-occurrence:${release.id}:${String(order).padStart(3,'0')}`,
    release_id:release.id,
    order,
    raw_text:raw,
    source_page:pageForPerson(release,status,index),
    source_annotation:annotation,
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
  return parts.map(part=>part.replace(/[.;]+$/,'').trim()).filter(Boolean);
}

function parseBoatComponent(raw){
  const text=String(raw||'').replace(/\s+/g,' ').replace(/[.;,]+$/,'').trim();
  const prefix=text.match(/^(M\/S|S\/S|R\/S|P\/S)\s*/i)?.[1]?.toUpperCase()||'';
  let name=text.replace(/^(?:M\/S|S\/S|R\/S|P\/S)\s*/i,'').trim();
  const yearMatch=name.match(/\s*\(([^()]*(?:\d{2,4})[^()]*)\)\s*$/);
  const registryYearRaw=yearMatch?.[1]?.trim()||'';
  if(yearMatch)name=name.slice(0,yearMatch.index).trim();
  const registryYears=(registryYearRaw.match(/\d{4}/g)||[]).map(Number);
  return {
    prefix,
    boat_name_raw:name,
    registry_year_raw:registryYearRaw,
    registry_year:/^\d{4}$/.test(registryYearRaw)?Number(registryYearRaw):null,
    registry_years:registryYears,
  };
}

const personNameIndex=new Map();const firstNameIndex=new Map();const clubNameIndex=new Map();const clubCoreIndex=new Map();
function indexPush(index,key,value){if(!key)return;if(!index.has(key))index.set(key,[]);index.get(key).push(value)}
for(const person of people){
  const names=unique([person.display_name,person.full_name,person.birth_name,...array(person.aliases)]);
  for(const name of names){indexPush(personNameIndex,normalize(name),person);indexPush(firstNameIndex,normalize(name).split(' ')[0],person)}
  if(person.club_name){
    indexPush(clubNameIndex,normalize(person.club_name),person);
    indexPush(clubCoreIndex,normalize(person.club_name).replace(/^(broder|syster|s)\s+/,'').trim(),person);
  }
}
const historicalPersonIndex=new Map();
for(const entity of historicalState.listEntities('person-occurrence')){
  const item=entity.fields;
  if(item.person_id&&item.confirmed)indexPush(historicalPersonIndex,normalize(item.person_name_raw),item.person_id);
}
function personMatch(item){
  const exact=unique((personNameIndex.get(normalize(item.person_name_raw))||[]).map(person=>person.id));
  if(exact.length===1)return {person_id:exact[0],match_status:'kopplad',match_method:'exakt personnamn',candidate_ids:exact,confirmed:true};
  const historical=unique(historicalPersonIndex.get(normalize(item.person_name_raw))||[]);
  if(historical.length===1)return {person_id:historical[0],match_status:'godkand',match_method:'tidigare källbelagd personidentitet',candidate_ids:historical,confirmed:true};
  const core=item.club_name_core_raw?unique((clubCoreIndex.get(normalize(item.club_name_core_raw))||[]).map(person=>person.id)):[];
  if(core.length===1)return {person_id:core[0],match_status:'kopplad',match_method:'exakt klubbnamnskärna',candidate_ids:core,confirmed:true};
  const first=normalize(item.person_name_raw).split(' ')[0];
  const candidates=unique([...(personNameIndex.get(normalize(item.person_name_raw))||[]),...(firstNameIndex.get(first)||[])].map(person=>person.id));
  return {person_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates.slice(0,12),confirmed:false};
}

function boatAliases(boat){
  const raw=[boat.namn,boat.dopnamn,boat.onskat_namn,...array(boat.smeknamn),...array(boat.tidigare_namn),...array(boat.senare_namn)];
  return unique(raw.flatMap(value=>String(value||'').split(/\/|\balias\b|\sa\.\s/i)).map(compact));
}
const boatsById=new Map(boats.map(boat=>[boat.id,boat]));
const boatIndex=new Map();
for(const boat of boats)for(const alias of boatAliases(boat))indexPush(boatIndex,alias,boat);
const historicalBoatIndex=new Map();
for(const entity of historicalState.listEntities('boat-occurrence')){
  const item=entity.fields;
  if(item.boat_id&&item.confirmed)indexPush(historicalBoatIndex,`${item.prefix||''}:${compact(item.boat_name_raw)}`,item.boat_id);
}
function confirmedBoat(boatId,method){
  if(!boatsById.has(boatId))throw new Error(`Källbelagd båt saknas i Båtregistret: ${boatId}`);
  return {boat_id:boatId,match_status:'godkand',match_method:method,candidate_ids:[boatId],confirmed:true};
}
function boatMatch(item){
  const nameKey=compact(item.boat_name_raw);
  if(nameKey==='filifjonkan'&&item.prefix==='M/S'&&item.registry_years.includes(1962))return confirmedBoat('filifjonkaniii','källbelagd identitetsrättning');
  if(nameKey==='majsol'&&item.prefix==='S/S'&&item.registry_years.includes(1975))return confirmedBoat('majsol_neretnieks','typ- och årtalsbelagd identitetsrättning');
  const historical=unique(historicalBoatIndex.get(`${item.prefix}:${nameKey}`)||[]);
  if(historical.length===1)return confirmedBoat(historical[0],'tidigare källbelagd båtidentitet');
  const keys=unique([item.boat_name_raw,...String(item.boat_name_raw||'').split(/\balias\b|\sa\.\s/i)].map(compact));
  const exactBoats=unique(keys.flatMap(value=>boatIndex.get(value)||[]).map(boat=>boat.id));
  if(exactBoats.length===1)return {boat_id:exactBoats[0],match_status:'kopplad',match_method:'exakt namn eller alias',candidate_ids:exactBoats,confirmed:true};
  if(exactBoats.length>1&&item.prefix){
    const typeCompatible=exactBoats.filter(id=>normalize(boatsById.get(id)?.typ||boatsById.get(id)?.type).includes(normalize(item.prefix)));
    if(typeCompatible.length===1)return {boat_id:typeCompatible[0],match_status:'kopplad',match_method:'entydigt namn och fartygstyp',candidate_ids:typeCompatible,confirmed:true};
  }
  const candidates=exactBoats.length?exactBoats:unique([...boatIndex.entries()].filter(([alias])=>nameKey.length>=4&&alias.length>=4&&(alias.includes(nameKey)||nameKey.includes(alias))).flatMap(([,values])=>values.map(boat=>boat.id))).slice(0,12);
  return {boat_id:null,match_status:candidates.length?'foreslagen':'saknas',match_method:candidates.length?'namnkandidater':'ingen träff',candidate_ids:candidates,confirmed:false};
}

const releases=[];const sourceRows=[];const personOccurrences=[];const boatOccurrences=[];
for(const releaseSource of source.releases){
  let personOrder=0;
  const categoryCounts={};
  for(const status of STATUS_ORDER){
    const lines=releaseSource.people?.[status]||[];
    categoryCounts[status]=lines.length;
    lines.forEach((raw,index)=>{
      personOrder+=1;
      const item=parseMemberLine(raw,releaseSource,status,index,personOrder);
      Object.assign(item,personMatch(item));
      personOccurrences.push(item);
      sourceRows.push({id:`source-row:${item.id}`,release_id:releaseSource.id,kind:'person',category:status,order:item.order,source_page:item.source_page,raw_text:item.raw_text,source_annotation:item.source_annotation,occurrence_ids:[item.id]});
    });
  }
  let boatOrder=0;
  const boatCategoryCounts={};
  releaseSource.boat_rows.forEach((row,rowIndex)=>{
    const lineOrder=rowIndex+1;
    const rowId=`source-row:${releaseSource.id}:boat:${String(lineOrder).padStart(3,'0')}`;
    const occurrenceIds=[];
    const components=row.components||splitOutsideParentheses(row.raw_text);
    boatCategoryCounts[row.category]=(boatCategoryCounts[row.category]||0)+1;
    components.forEach((component,componentIndex)=>{
      boatOrder+=1;
      const parsed=parseBoatComponent(component);
      const id=`boat-occurrence:${releaseSource.id}:${String(lineOrder).padStart(3,'0')}:${componentIndex+1}`;
      const match=boatMatch(parsed);
      boatOccurrences.push({
        id,release_id:releaseSource.id,source_row_id:rowId,order:boatOrder,source_line_order:lineOrder,component_order:componentIndex+1,
        source_page:row.page,source_category:row.category,source_annotation:row.annotation||'',raw_text:component,source_line_raw:row.raw_text,...parsed,...match,
      });
      occurrenceIds.push(id);
    });
    sourceRows.push({id:rowId,release_id:releaseSource.id,kind:'boat',category:row.category,order:lineOrder,source_page:row.page,raw_text:row.raw_text,source_annotation:row.annotation||'',occurrence_ids:occurrenceIds});
  });
  releases.push({
    id:releaseSource.id,year:releaseSource.year,as_of:releaseSource.as_of,title:releaseSource.title,
    source_document_id:source.source_group_id,source_page_count:3,source_date:releaseSource.source_date||'',source_signature:releaseSource.source_signature||'',
    person_row_count:personOrder,person_category_counts:categoryCounts,boat_source_row_count:releaseSource.boat_rows.length,
    boat_occurrence_count:boatOrder,boat_category_counts:boatCategoryCounts,sort_order:'källordning',release_type:'medlemsmatrikel',
  });
}

let seq=0;const operations=[];
function set(entityType,entityId,field,value){
  seq+=1;
  operations.push({op_id:`${DEVICE}:${seq}`,device_id:DEVICE,seq,entity_type:entityType,entity_id:entityId,field,value:value===undefined?null:value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`,schema_version:1});
}
function add(type,item){const {id,...fields}=item;for(const [field,value] of Object.entries(fields))set(type,id,field,value)}

const sourceHash=sha256(sourceBytes);
const sourceFileHashes=Object.fromEntries(source.source_files.map(file=>[file.filename,file.sha256]));
add('source-document',{id:source.source_group_id,label:source.label,private_copy:'privat/kallkopior/matriklar-1991-1998.json',sha256:sourceHash,source_file_hashes:sourceFileHashes,source_file_count:source.source_files.length,source_type:source.source_type,immutable:true});
for(const release of releases)add('matrikel-release',release);
for(const row of sourceRows)add('source-row',row);
for(const item of personOccurrences)add('person-occurrence',item);
for(const item of boatOccurrences)add('boat-occurrence',item);

const baseRoot=baseState.getEntity('club-history-root','club-history-root:kbk')?.fields||{};
set('club-history-root','club-history-root:kbk','release_ids',['matrikel-1980','matrikel-1986','matrikel-1991','matrikel-1998','matrikel-2025']);
set('club-history-root','club-history-root:kbk','source_hashes',{...(baseRoot.source_hashes||{}),supplemental:sourceHash});

const releaseCounts=Object.fromEntries(releases.map(release=>[
  release.id,
  {
    person_rows:personOccurrences.filter(item=>item.release_id===release.id).length,
    person_categories:release.person_category_counts,
    boat_source_rows:sourceRows.filter(item=>item.release_id===release.id&&item.kind==='boat').length,
    boat_occurrences:boatOccurrences.filter(item=>item.release_id===release.id).length,
    boat_categories:release.boat_category_counts,
    connected_person_rows:personOccurrences.filter(item=>item.release_id===release.id&&item.person_id&&item.confirmed).length,
    unresolved_person_rows:personOccurrences.filter(item=>item.release_id===release.id&&(!item.person_id||!item.confirmed)).length,
    connected_boat_occurrences:boatOccurrences.filter(item=>item.release_id===release.id&&item.boat_id&&item.confirmed).length,
    unresolved_boat_occurrences:boatOccurrences.filter(item=>item.release_id===release.id&&(!item.boat_id||!item.confirmed)).length,
  },
]));
const report={
  generated_on:'2026-08-03',
  contract:'Varje synlig medlemsrad och fartygsrad bevaras; osäkra identiteter godkänns inte tyst.',
  source_sha256:sourceHash,
  source_file_hashes:sourceFileHashes,
  release_counts:releaseCounts,
  counts:{releases:releases.length,source_rows:sourceRows.length,person_occurrences:personOccurrences.length,boat_occurrences:boatOccurrences.length,operations:operations.length},
  unresolved_people:personOccurrences.filter(item=>!item.person_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.person_name_raw,status:item.match_status,candidate_ids:item.candidate_ids})),
  unresolved_boats:boatOccurrences.filter(item=>!item.boat_id||!item.confirmed).map(item=>({occurrence_id:item.id,release_id:item.release_id,raw_name:item.boat_name_raw,prefix:item.prefix,registry_year_raw:item.registry_year_raw,status:item.match_status,candidate_ids:item.candidate_ids})),
};
const document={operations_version:1,ingest_id:'klubbhistorik-matriklar-1991-1998-2026-08-03',device_id:DEVICE,source_sha256:sourceHash,operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),counts:report.counts,operations};
await mkdir(dirname(OUT_PATH),{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(document,null,2)}\n`);
await writeFile(REPORT_PATH,`${JSON.stringify(report,null,2)}\n`);
console.log(`Tilläggsmatriklar byggda: ${personOccurrences.length} medlemsrader, ${boatOccurrences.length} båtförekomster, ${report.unresolved_people.length} personrader och ${report.unresolved_boats.length} båtar till granskning.`);
