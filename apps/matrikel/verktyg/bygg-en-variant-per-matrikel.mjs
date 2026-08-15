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
const OUT_FILE='2026-08-03-en-sorteringsvariant-per-matrikel.json';
const OUT_PATH=resolve(CORRECTIONS,OUT_FILE);
const DEVICE='correction-klubbhistorik-en-sorteringsvariant-2026-08-03';
const CLOCK_MS=Date.UTC(2026,7,3,21,0,0);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const pad=value=>String(value).padStart(3,'0');
const occurrenceKey=item=>`${normalize(item.person_name_raw)}|${item.birth_year||''}`;

const baseDocument=JSON.parse(await readFile(BASE_PATH,'utf8'));
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')&&file!==OUT_FILE).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readFile(resolve(CORRECTIONS,file),'utf8').then(JSON.parse)));
const previousState=materialize([...baseDocument.operations,...correctionDocuments.flatMap(document=>document.operations||document.ops||[])]);
const sourceFiles=(await readdir(SOURCES)).filter(file=>file.endsWith('.json')).sort((a,b)=>a.localeCompare(b,'sv'));
const sources=await Promise.all(sourceFiles.map(async file=>{const bytes=await readFile(resolve(SOURCES,file));return {file,bytes,json:JSON.parse(bytes)}}));

const selectedByRelease=new Map();
for(const source of sources){
  if(!source.json.document.is_primary_for_release)throw new Error(`JSON-filen är inte vald variant: ${source.file}`);
  if(selectedByRelease.has(source.json.release.id))throw new Error(`Flera JSON-varianter finns kvar för ${source.json.release.id}`);
  selectedByRelease.set(source.json.release.id,source);
}

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push(createSetOperation({deviceId:DEVICE,seq,entityType,entityId,field,value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`}))}

const previousSourceDocuments=previousState.listEntities('source-document').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousSourceRows=previousState.listEntities('source-row').map(entity=>({id:entity.entity_id,...entity.fields}));
const previousOccurrences=previousState.listEntities('person-occurrence').map(entity=>({id:entity.entity_id,...entity.fields}));
const switchedReleases=[];let retiredDocuments=0;let retiredLegacyDocuments=0;let retiredRows=0;let activatedRows=0;let remappedOccurrences=0;

for(const item of previousSourceDocuments.filter(document=>!document.release_id)){
  set('source-document',item.id,'retained',false);
  set('source-document',item.id,'selection_note','Äldre samlingsunderlag, ersatt av en vald JSON-fil per matrikelutgåva. Källfilen och operationshistoriken är oförändrade.');
  retiredLegacyDocuments+=1;
}

for(const [releaseId,source] of selectedByRelease){
  const document=source.json;
  if(document.release.release_type!=='vem-ar-vem')continue;
  const selectedId=document.document.id;
  const releaseEntity=previousState.getEntity('matrikel-release',releaseId)?.fields;
  if(!releaseEntity)throw new Error(`Utgåvan saknas i mastern: ${releaseId}`);
  const releaseDocuments=previousSourceDocuments.filter(item=>item.release_id===releaseId);
  if(!releaseDocuments.some(item=>item.id===selectedId))throw new Error(`Källdokumentet saknas i den tidigare mastern: ${selectedId}`);

  for(const item of releaseDocuments){
    const retained=item.id===selectedId;
    set('source-document',item.id,'retained',retained);
    set('source-document',item.id,'is_primary_for_release',retained);
    set('source-document',item.id,'selection_note',retained?`Vald ensamvariant; ${document.release.sort_order} prioriterades.`:'Alternativ sorteringsvariant; inte aktiv i Matrikeln. Arkivoriginalet är oförändrat.');
    if(!retained)retiredDocuments+=1;
  }
  set('source-document',selectedId,'label',document.document.label);
  set('source-document',selectedId,'private_copy',`privat/kallkopior/matriklar/${source.file}`);
  set('source-document',selectedId,'sha256',sha256(source.bytes));
  set('source-document',selectedId,'source_file_hashes',Object.fromEntries(document.document.original_files.map(file=>[file.original_filename,file.sha256])));
  set('source-document',selectedId,'source_file_count',document.document.original_files.length);
  set('source-document',selectedId,'sort_order',document.release.sort_order);

  set('matrikel-release',releaseId,'source_document_id',selectedId);
  set('matrikel-release',releaseId,'source_document_ids',[selectedId]);
  set('matrikel-release',releaseId,'sort_order',document.release.sort_order);
  set('matrikel-release',releaseId,'source_variant_policy','en vald variant per utgåva');

  const oldSelectedId=releaseEntity.source_document_id;
  if(oldSelectedId===selectedId)continue;
  switchedReleases.push({release_id:releaseId,from:oldSelectedId,to:selectedId,sort_order:document.release.sort_order});

  for(const row of previousSourceRows.filter(item=>item.release_id===releaseId&&item.kind==='person'&&item.source_document_id===oldSelectedId&&item.id.startsWith('source-row:canonical:'))){
    set('source-row',row.id,'retained',false);retiredRows+=1;
  }

  const occurrences=previousOccurrences.filter(item=>item.release_id===releaseId);
  const occurrenceIndex=new Map();
  for(const occurrence of occurrences){
    const key=occurrenceKey(occurrence);
    if(occurrenceIndex.has(key))throw new Error(`Dubbla medlemsförekomster vid variantbyte: ${releaseId} ${key}`);
    occurrenceIndex.set(key,occurrence);
  }
  const used=new Set();
  for(const row of document.member_rows.filter(item=>item.category!=='blank'&&item.person_name_raw)){
    const occurrence=occurrenceIndex.get(occurrenceKey(row));
    if(!occurrence)throw new Error(`Medlemsförekomst saknas vid variantbyte: ${releaseId} ${row.person_name_raw}`);
    if(used.has(occurrence.id))throw new Error(`Medlemsförekomsten används två gånger: ${occurrence.id}`);used.add(occurrence.id);
    const rowId=`source-row:canonical:${selectedId}:member:${pad(row.order)}`;
    const fields={source_document_id:selectedId,source_row_id:rowId,canonical_source_row_id:rowId,order:row.order,raw_text:row.raw_text,source_page:row.page,source_annotation:row.source_annotation,person_name_raw:row.person_name_raw,club_name_core_raw:row.club_name_core_raw,membership_status:row.category,induction_year_raw:row.induction_year_raw,induction_year:row.induction_year,age_raw:row.age_raw,birth_year_raw:row.birth_year_raw,birth_year:row.birth_year,birth_date_raw:row.birth_date_raw,birth_date:row.birth_date,island_raw:row.island_raw,club_name_raw:row.club_name_raw,relation_raw:row.relation_raw};
    for(const [field,value] of Object.entries(fields))set('person-occurrence',occurrence.id,field,value);
    const sourceRow={release_id:releaseId,source_document_id:selectedId,kind:'person',category:row.category,order:row.order,source_page:row.page,raw_text:row.raw_text,source_annotation:row.source_annotation,occurrence_ids:[occurrence.id],retained:true};
    for(const [field,value] of Object.entries(sourceRow))set('source-row',rowId,field,value);
    activatedRows+=1;remappedOccurrences+=1;
  }
  if(used.size!==occurrences.length)throw new Error(`Variantbytet täcker ${used.size}/${occurrences.length} medlemsförekomster i ${releaseId}`);
}

const selectedHashes=Object.fromEntries(sources.map(source=>[source.json.document.id,sha256(source.bytes)]));
set('club-history-root','club-history-root:kbk','canonical_source_hashes',selectedHashes);
set('club-history-root','club-history-root:kbk','source_document_count',sources.length);
set('club-history-root','club-history-root:kbk','source_variant_policy','en vald JSON-variant per matrikelutgåva; ålder eller födelsedatum prioriteras');

const document={
  operations_version:1,
  correction_id:'en-sorteringsvariant-per-matrikel',
  device_id:DEVICE,
  reason:'Moderna matriklar ska ha en enda aktiv JSON- och källvariant. Ålder eller födelsedatum väljs när den sorteringen finns; alternativa original-PDF:er ändras inte.',
  selected_source_documents:Object.fromEntries([...selectedByRelease].map(([releaseId,source])=>[releaseId,source.json.document.id])),
  switched_releases:switchedReleases,
  counts:{selected_documents:sources.length,retired_documents:retiredDocuments,retired_legacy_documents:retiredLegacyDocuments,retired_source_rows:retiredRows,activated_source_rows:activatedRows,remapped_person_occurrences:remappedOccurrences,operations:operations.length},
  operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),
  operations,
};

await mkdir(CORRECTIONS,{recursive:true});
await writeFile(OUT_PATH,`${JSON.stringify(document,null,2)}\n`);
console.log(`En variant per matrikel: ${sources.length} valda JSON-filer, ${retiredDocuments} alternativa källdokument och ${retiredLegacyDocuments} äldre samlingsunderlag inaktiverade samt ${remappedOccurrences} medlemsförekomster omordnade.`);
