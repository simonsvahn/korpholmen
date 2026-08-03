import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SOURCE_DIR=resolve(ROOT,'privat/kallkopior/matriklar');
const TOP_KEYS=['schema_version','document','release','columns','sections','member_rows','boat_rows','document_notes'];
const MEMBER_KEYS=['id','order','page','category','raw_text','source_annotation','induction_year_raw','induction_year','first_name_raw','last_name_raw','person_name_raw','club_name_core_raw','age_raw','birth_year_raw','birth_year','birth_date_raw','birth_date','island_raw','club_name_raw','relation_raw'];
const BOAT_KEYS=['id','order','page','category','raw_text','source_annotation','components'];
const COMPONENT_KEYS=['order','raw_text','prefix','boat_name_raw','registry_year_raw','registry_year','registry_years'];
const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const rowKey=row=>`${normalize(row.person_name_raw)}|${row.birth_year||row.birth_date_raw||''}`;
const difference=(left,right)=>[...left].filter(value=>!right.has(value));

const files=(await readdir(SOURCE_DIR)).filter(file=>file.endsWith('.json')).sort((a,b)=>a.localeCompare(b,'sv'));
const documents=[];const documentIds=new Set();const rowIds=new Set();const years=new Set();
for(const file of files){
  const document=JSON.parse(await readFile(resolve(SOURCE_DIR,file),'utf8'));
  if(JSON.stringify(Object.keys(document))!==JSON.stringify(TOP_KEYS))throw new Error(`${file}: osynkade toppnivåfält.`);
  if(document.schema_version!==1)throw new Error(`${file}: fel schemaversion.`);
  if(documentIds.has(document.document.id))throw new Error(`${file}: dubbelt document.id ${document.document.id}.`);documentIds.add(document.document.id);
  if(file!==`matrikel-${document.release.year}.json`)throw new Error(`${file}: årsfilen ska heta matrikel-${document.release.year}.json.`);
  if(document.release.id!==`matrikel-${document.release.year}`)throw new Error(`${file}: release.id ska vara matrikel-${document.release.year}.`);
  if(years.has(document.release.year))throw new Error(`${file}: kalenderåret ${document.release.year} finns i flera JSON-filer.`);years.add(document.release.year);
  for(const row of document.member_rows){
    if(JSON.stringify(Object.keys(row))!==JSON.stringify(MEMBER_KEYS))throw new Error(`${file}: osynkad medlemsrad ${row.id}.`);
    if(rowIds.has(row.id))throw new Error(`${file}: dubbelt rad-id ${row.id}.`);rowIds.add(row.id);
  }
  for(const row of document.boat_rows){
    if(JSON.stringify(Object.keys(row))!==JSON.stringify(BOAT_KEYS))throw new Error(`${file}: osynkad båtrad ${row.id}.`);
    if(rowIds.has(row.id))throw new Error(`${file}: dubbelt rad-id ${row.id}.`);rowIds.add(row.id);
    for(const component of row.components)if(JSON.stringify(Object.keys(component))!==JSON.stringify(COMPONENT_KEYS))throw new Error(`${file}: osynkad båtkomponent ${row.id}.`);
  }
  for(const source of document.document.original_files){
    const privatePath=resolve(ROOT,source.private_copy.replace(/^privat\//,'privat/'));
    const bytes=await readFile(privatePath);
    if(bytes.length!==source.bytes||sha256(bytes)!==source.sha256)throw new Error(`${file}: källkopian av ${source.original_filename} stämmer inte med metadata.`);
  }
  documents.push({file,...document});
}

const releases=new Map();
for(const document of documents){const id=document.release.id;if(!releases.has(id))releases.set(id,[]);releases.get(id).push(document)}
const discrepancies=[];const duplicateRows=[];const releaseCounts={};
for(const [releaseId,variants] of releases){
  if(variants.length!==1)throw new Error(`${releaseId}: exakt en JSON-variant krävs, fick ${variants.length}.`);
  const primary=variants.filter(document=>document.document.is_primary_for_release);
  if(primary.length!==1)throw new Error(`${releaseId}: förväntade ett primärdokument, fick ${primary.length}.`);
  const primaryRows=primary[0].member_rows.filter(row=>row.category!=='blank'&&row.person_name_raw);
  const seen=new Map();
  for(const row of primaryRows){const key=rowKey(row);if(!seen.has(key))seen.set(key,[]);seen.get(key).push(row.id)}
  for(const [key,ids] of seen)if(ids.length>1)duplicateRows.push({release_id:releaseId,key,row_ids:ids});
  const primaryKeys=new Set(primaryRows.map(rowKey));
  for(const variant of variants){
    const variantKeys=new Set(variant.member_rows.filter(row=>row.category!=='blank'&&row.person_name_raw).map(rowKey));
    const onlyPrimary=difference(primaryKeys,variantKeys);const onlyVariant=difference(variantKeys,primaryKeys);
    if(onlyPrimary.length||onlyVariant.length)discrepancies.push({release_id:releaseId,document_id:variant.document.id,only_primary:onlyPrimary,only_variant:onlyVariant});
  }
  releaseCounts[releaseId]={documents:variants.length,primary_document_id:primary[0].document.id,member_rows:primaryRows.length,boat_rows:primary[0].boat_rows.filter(row=>row.category!=='blank').length,boat_occurrences:primary[0].boat_rows.flatMap(row=>row.components).length};
}

if(discrepancies.length)throw new Error(`Sorteringsvarianter skiljer sig: ${JSON.stringify(discrepancies.slice(0,10))}`);
console.log(JSON.stringify({schema_version:1,documents:documents.length,releases:releases.size,years:[...years].sort((a,b)=>a-b),source_files:documents.reduce((sum,document)=>sum+document.document.original_files.length,0),member_rows_in_primary_documents:Object.values(releaseCounts).reduce((sum,release)=>sum+release.member_rows,0),boat_rows_in_primary_documents:Object.values(releaseCounts).reduce((sum,release)=>sum+release.boat_rows,0),boat_occurrences_in_primary_documents:Object.values(releaseCounts).reduce((sum,release)=>sum+release.boat_occurrences,0),source_duplicate_groups:duplicateRows,release_counts:releaseCounts},null,2));
