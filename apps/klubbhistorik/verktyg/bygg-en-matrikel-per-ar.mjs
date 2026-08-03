import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const SOURCES=resolve(PRIVATE,'kallkopior/matriklar');
const BASE_PATH=resolve(PRIVATE,'migrering-2026-08-02/initial-ops.json');
const CORRECTIONS=resolve(PRIVATE,'korrigeringar');
const OUT_FILE='2026-08-03-kalltrogen-layout-v3.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const DEVICE='correction-klubbhistorik-kalltrogen-layout-v3-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,3,23,45,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const pad=value=>String(value).padStart(3,'0');

const baseDocument=JSON.parse(await readFile(BASE_PATH,'utf8'));
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const previousState=materialize([...baseDocument.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])]);
const sourceFiles=(await readdir(SOURCES)).filter(file=>/^matrikel-\d{4}\.json$/.test(file)).sort((a,b)=>a.localeCompare(b,'sv'));
const sources=await Promise.all(sourceFiles.map(async file=>{const bytes=await readFile(resolve(SOURCES,file));return {file,bytes,json:JSON.parse(bytes)}}));

if(!sources.length)throw new Error('Inga årsvisa matrikel-JSON-filer hittades.');
const years=sources.map(source=>source.json.release.year);
if(new Set(years).size!==years.length)throw new Error('Flera årsvisa JSON-filer har samma kalenderår.');
for(const source of sources){
  const {year,id}=source.json.release;
  if(source.file!==`matrikel-${year}.json`||id!==`matrikel-${year}`)throw new Error(`Årsfilen har fel namn eller release-id: ${source.file} / ${id}`);
  if(!source.json.document.is_primary_for_release)throw new Error(`Årsfilen är inte primär: ${source.file}`);
}

const previousReleases=previousState.listEntities('matrikel-release').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousDocuments=previousState.listEntities('source-document').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousRows=previousState.listEntities('source-row').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousLayouts=previousState.listEntities('source-layout-row').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousPeople=previousState.listEntities('person-occurrence').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousBoats=previousState.listEntities('boat-occurrence').map(entity=>({id:entity.entity_id,...entity.fields}));

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}
function setFields(entityType,entityId,fields){for(const [field,value] of Object.entries(fields))set(entityType,entityId,field,value)}

function directPerson(document,row){
  const oldDocumentId=document.document.selected_source_document_id||document.document.id;
  const oldReleaseId=document.document.selected_source_release_id||document.release.id;
  const oldRowId=`source-row:canonical:${oldDocumentId}:member:${pad(row.order)}`;
  let matches=previousPeople.filter(item=>item.retained!==false&&(item.canonical_source_row_id===oldRowId||item.source_row_id===oldRowId));
  if(matches.length!==1)matches=previousPeople.filter(item=>item.retained!==false&&item.release_id===document.release.id&&item.membership_status===row.category&&normalize(item.raw_text)===normalize(row.raw_text));
  if(matches.length!==1)matches=previousPeople.filter(item=>item.retained!==false&&item.release_id===oldReleaseId&&item.membership_status===row.category&&normalize(item.raw_text)===normalize(row.raw_text));
  if(matches.length!==1)throw new Error(`Kunde inte återanvända exakt en personförekomst för ${document.release.id}, rad ${row.order}: ${row.person_name_raw} (${matches.length}).`);
  return matches[0];
}

function directBoat(document,row,component){
  const oldDocumentId=document.document.selected_source_document_id||document.document.id;
  const oldReleaseId=document.document.selected_source_release_id||document.release.id;
  const oldRowId=`source-row:canonical:${oldDocumentId}:boat:${pad(row.order)}`;
  let matches=previousBoats.filter(item=>item.retained!==false&&(item.canonical_source_row_id===oldRowId||item.source_row_id===oldRowId)&&item.component_order===component.order);
  if(matches.length!==1)matches=previousBoats.filter(item=>item.retained!==false&&item.release_id===document.release.id&&item.source_line_order===row.order&&item.component_order===component.order&&normalize(item.raw_text)===normalize(component.raw_text));
  if(matches.length!==1)matches=previousBoats.filter(item=>item.retained!==false&&item.release_id===oldReleaseId&&item.source_line_order===row.order&&item.component_order===component.order&&normalize(item.raw_text)===normalize(component.raw_text));
  if(matches.length!==1)throw new Error(`Kunde inte återanvända exakt en båtförekomst för ${document.release.id}, rad ${row.order}.${component.order}: ${component.boat_name_raw} (${matches.length}).`);
  return matches[0];
}

const activeReleaseIds=new Set();const activeDocumentIds=new Set();const activeRowIds=new Set();const activeLayoutIds=new Set();const activePersonIds=new Set();const activeBoatIds=new Set();
const releases=[];const selection={};

for(const source of sources){
  const document=source.json;const release=document.release;const releaseId=release.id;const documentId=document.document.id;
  activeReleaseIds.add(releaseId);activeDocumentIds.add(documentId);
  selection[releaseId]={selected_source_release_id:document.document.selected_source_release_id||releaseId,selected_source_document_id:document.document.selected_source_document_id||documentId,as_of:release.as_of,sort_order:release.sort_order};

  setFields('source-document',documentId,{
    label:document.document.label,
    private_copy:`privat/kallkopior/matriklar/${source.file}`,
    sha256:sha256(source.bytes),
    source_type:document.document.source_type,
    source_file_hashes:Object.fromEntries(document.document.original_files.map(file=>[file.original_filename,file.sha256])),
    source_file_count:document.document.original_files.length,
    selected_source_document_id:document.document.selected_source_document_id||documentId,
    selected_source_release_id:document.document.selected_source_release_id||releaseId,
    is_primary_for_release:true,
    release_id:releaseId,
    sort_order:release.sort_order,
    retained:true,
    selection_note:'Vald årsfil. Övriga exporter för kalenderåret ligger kvar som hashad proveniens i JSON-filen men är inte egna matrikelutgåvor.',
    immutable:true,
    schema_version:document.schema_version,
  });

  let personOccurrenceCount=0;let boatOccurrenceCount=0;const canonicalMemberRows=new Map();const canonicalBoatRows=new Map();
  for(const row of document.member_rows){
    const rowId=`source-row:canonical:${documentId}:member:${pad(row.order)}`;const occurrenceIds=[];activeRowIds.add(rowId);
    canonicalMemberRows.set(row.id,rowId);
    const components=row.person_components||((row.category!=='blank'&&row.person_name_raw)?[{order:1,person_name_raw:row.person_name_raw}]:[]);
    let reused=null;if(components.length)reused=directPerson(document,row);
    for(const [componentIndex,component] of components.entries()){
      personOccurrenceCount+=1;const occurrenceId=componentIndex===0?reused.id:`${reused.id}:component:${String(component.order).padStart(2,'0')}`;activePersonIds.add(occurrenceId);occurrenceIds.push(occurrenceId);
      setFields('person-occurrence',occurrenceId,{
        release_id:releaseId,source_document_id:documentId,source_row_id:rowId,canonical_source_row_id:rowId,order:row.order,
        raw_text:row.raw_text,source_page:row.page,source_annotation:row.source_annotation,person_name_raw:component.person_name_raw,
        source_person_name_raw:row.person_name_raw,source_entity_kind:row.entity_kind,component_order:component.order,
        club_name_core_raw:row.club_name_core_raw,membership_status:row.category,induction_year_raw:row.induction_year_raw,
        induction_year:row.induction_year,age_raw:row.age_raw,birth_year_raw:row.birth_year_raw,birth_year:row.birth_year,
        birth_date_raw:row.birth_date_raw,birth_date:row.birth_date,island_raw:row.island_raw,club_name_raw:row.club_name_raw,
        relation_raw:row.relation_raw,retained:true,
      });
      if(row.entity_kind==='multiple_people')setFields('person-occurrence',occurrenceId,{person_id:null,match_status:'saknas',match_method:'separerad flerspersonrad i källan; identiteten måste granskas',candidate_ids:[],confirmed:false,decision_note:'Källraden innehåller flera personer. Förekomsten har separerats utan att en masteridentitet antagits.'});
    }
    setFields('source-row',rowId,{release_id:releaseId,source_document_id:documentId,kind:'person',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,source_entity_kind:row.entity_kind,person_component_count:components.length,occurrence_ids:occurrenceIds,retained:true});
  }

  for(const row of document.boat_rows){
    const rowId=`source-row:canonical:${documentId}:boat:${pad(row.order)}`;const occurrenceIds=[];activeRowIds.add(rowId);
    canonicalBoatRows.set(row.id,rowId);
    for(const component of row.components){
      boatOccurrenceCount+=1;const occurrence=directBoat(document,row,component);activeBoatIds.add(occurrence.id);occurrenceIds.push(occurrence.id);
      setFields('boat-occurrence',occurrence.id,{
        release_id:releaseId,source_document_id:documentId,source_row_id:rowId,canonical_source_row_id:rowId,order:boatOccurrenceCount,
        source_line_order:row.order,component_order:component.order,source_page:row.page,source_category:row.category,
        source_annotation:row.source_annotation,raw_text:component.raw_text,source_line_raw:row.raw_text,prefix:component.prefix,
        boat_name_raw:component.boat_name_raw,registry_year_raw:component.registry_year_raw,registry_year:component.registry_year,
        registry_years:component.registry_years,registry_periods:component.registry_periods||[],retained:true,
      });
    }
    setFields('source-row',rowId,{release_id:releaseId,source_document_id:documentId,kind:'boat',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,associated_member_source_row_id:row.associated_member_row_id?canonicalMemberRows.get(row.associated_member_row_id)||null:null,occurrence_ids:occurrenceIds,retained:true});
  }

  for(const row of document.layout_rows||[]){
    const layoutId=row.id;activeLayoutIds.add(layoutId);
    setFields('source-layout-row',layoutId,{release_id:releaseId,source_document_id:documentId,order:row.order,source_page:row.page,kind:row.kind,section:row.section,text_raw:row.text_raw,member_source_row_id:row.member_row_id?canonicalMemberRows.get(row.member_row_id)||null:null,boat_source_row_ids:row.boat_row_ids.map(id=>canonicalBoatRows.get(id)).filter(Boolean),retained:true});
  }

  const personCategories=Object.fromEntries([...new Set(document.member_rows.map(row=>row.category))].map(category=>[category,document.member_rows.filter(row=>row.category===category).length]));
  const boatCategories=Object.fromEntries([...new Set(document.boat_rows.map(row=>row.category))].map(category=>[category,document.boat_rows.filter(row=>row.category===category).length]));
  const item={...release,source_document_id:documentId,source_document_ids:[documentId],person_row_count:personOccurrenceCount,source_member_row_count:document.member_rows.length,person_category_counts:personCategories,boat_source_row_count:document.boat_rows.length,boat_occurrence_count:boatOccurrenceCount,boat_category_counts:boatCategories,layout_row_count:(document.layout_rows||[]).length,canonical_schema_version:document.schema_version,source_variant_policy:'en JSON per kalenderår',retained:true};
  releases.push(item);setFields('matrikel-release',releaseId,item);
}

let retiredReleases=0;let retiredDocuments=0;let retiredRows=0;let retiredLayouts=0;let retiredPeople=0;let retiredBoats=0;
for(const item of previousReleases)if(!activeReleaseIds.has(item.id)){set('matrikel-release',item.id,'retained',false);retiredReleases+=1}
for(const item of previousDocuments)if(!activeDocumentIds.has(item.id)){set('source-document',item.id,'retained',false);retiredDocuments+=1}
for(const item of previousRows)if(!activeRowIds.has(item.id)){set('source-row',item.id,'retained',false);retiredRows+=1}
for(const item of previousLayouts)if(!activeLayoutIds.has(item.id)){set('source-layout-row',item.id,'retained',false);retiredLayouts+=1}
for(const item of previousPeople)if(!activePersonIds.has(item.id)){set('person-occurrence',item.id,'retained',false);retiredPeople+=1}
for(const item of previousBoats)if(!activeBoatIds.has(item.id)){set('boat-occurrence',item.id,'retained',false);retiredBoats+=1}

const releaseIds=releases.slice().sort((a,b)=>String(a.as_of).localeCompare(String(b.as_of),'sv')).map(release=>release.id);
setFields('club-history-root','club-history-root:kbk',{
  release_ids:releaseIds,
  canonical_source_hashes:Object.fromEntries(sources.map(source=>[source.json.document.id,sha256(source.bytes)])),
  canonical_schema_version:2,
  source_document_count:sources.length,
  source_variant_policy:'en validerad JSON per kalenderår; alternativa exporter bevaras endast som källproveniens',
});

const counts={active_releases:activeReleaseIds.size,active_source_documents:activeDocumentIds.size,active_source_rows:activeRowIds.size,active_source_layout_rows:activeLayoutIds.size,active_person_occurrences:activePersonIds.size,active_boat_occurrences:activeBoatIds.size,retired_releases:retiredReleases,retired_source_documents:retiredDocuments,retired_source_rows:retiredRows,retired_source_layout_rows:retiredLayouts,retired_person_occurrences:retiredPeople,retired_boat_occurrences:retiredBoats,operations:operations.length};
const output={operations_version:1,correction_id:'kalltrogen-layout-v3',device_id:DEVICE,reason:'V3 bevarar trycksidans radlayout, separerar flerspersonrader och lagrar öppna eller förkortade båtårsintervall utan att skapa ägarpåståenden eller skriva över tidigare distribuerade operationer.',selection,counts,operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),operations};
await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(output,null,2)}\n`);
console.log(`Källtrogen layout: ${counts.active_releases} årsutgåvor, ${counts.active_source_layout_rows} layoutrader, ${counts.active_person_occurrences} medlemsförekomster och ${counts.active_boat_occurrences} båtförekomster aktiva.`);
