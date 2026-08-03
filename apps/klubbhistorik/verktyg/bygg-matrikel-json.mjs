import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BOAT_MEMBER_ANCHORS, CORRESPONDING_NOTE, buildLayoutRows, exactLegacySections, personStructure } from './matrikel-kallayout.mjs';

const execFileAsync=promisify(execFile);
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PRIVATE=resolve(ROOT,'privat');
const DEFAULT_SOURCE_ROOT='/Users/simon/Dropbox/AI/Projekt/2 Wikis & källor/Wiki Korpholmen & släkten/källmaterial/07 KBK-arkivet/Matriklar och Vem-är-vem';
const DEFAULT_OUTPUT=resolve(PRIVATE,'kallkopior/matriklar');
const LEGACY_1991_1998=resolve(PRIVATE,'kallkopior/matriklar-1991-1998.json');
const args=process.argv.slice(2);
const valueAfter=flag=>{const index=args.indexOf(flag);return index>=0?args[index+1]:null};
const SOURCE_ROOT=resolve(valueAfter('--source-root')||DEFAULT_SOURCE_ROOT);
const OUTPUT=resolve(valueAfter('--output')||DEFAULT_OUTPUT);
const ORIGINALS=resolve(OUTPUT,'original');
const HISTORICAL_INPUT=valueAfter('--historical');
const PDFTOTEXT=valueAfter('--pdftotext')||'/opt/homebrew/bin/pdftotext';
const ISLANDS=new Set(['Korpholmen','Sviholmen','Ängsholmen','Blidö','Svanö']);
const MEMBER_KEYS=['id','order','page','category','raw_text','source_annotation','induction_year_raw','induction_year','first_name_raw','last_name_raw','person_name_raw','club_name_core_raw','age_raw','birth_year_raw','birth_year','birth_date_raw','birth_date','island_raw','club_name_raw','relation_raw','entity_kind','person_components'];
const BOAT_KEYS=['id','order','page','category','raw_text','source_annotation','components','associated_member_row_id'];
const COMPONENT_KEYS=['order','raw_text','prefix','boat_name_raw','registry_year_raw','registry_year','registry_years','registry_periods'];
const LAYOUT_KEYS=['id','order','page','kind','section','member_row_id','boat_row_ids','text_raw'];

const sha256=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const slug=value=>normalize(value).replaceAll(' ','-');
const pad=value=>String(value).padStart(3,'0');

function validBirthDate(raw,birthYear){
  if(!/^\d{8}$/.test(raw)||Number(raw.slice(0,4))!==birthYear)return null;
  const year=Number(raw.slice(0,4));const month=Number(raw.slice(4,6));const day=Number(raw.slice(6,8));
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`:null;
}

function historicName(raw){
  const text=String(raw||'').trim();
  const leading=text.match(/^\(([^)]+?)[-–—]\)\s*([^\s]+)(?:\s+(.+))?$/);
  const trailing=text.match(/^([^\s(]+)\s*\(\s*[-–—]([^)]+)\)\s*(.*)$/);
  let clubCore='';
  if(leading)clubCore=`${leading[1]}-${leading[2]}`;
  if(trailing)clubCore=`${trailing[1]}-${trailing[2]}`;
  return {personName:text.replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim(),clubCore};
}

function blankMember({id,order,page,category,rawText='',annotation='',inductionYearRaw='',firstName='',lastName='',personName='',clubCore='',ageRaw='',birthYearRaw='',birthDateRaw='',island='',clubName='',relation=''}){
  const inductionYear=/^\d{4}$/.test(inductionYearRaw)?Number(inductionYearRaw):null;
  const birthYear=/^\d{4}$/.test(birthYearRaw)?Number(birthYearRaw):null;
  const structure=personStructure(personName,category);
  return {id,order,page,category,raw_text:rawText,source_annotation:annotation,induction_year_raw:inductionYearRaw,induction_year:inductionYear,first_name_raw:firstName,last_name_raw:lastName,person_name_raw:personName,club_name_core_raw:clubCore,age_raw:ageRaw,birth_year_raw:birthYearRaw,birth_year:birthYear,birth_date_raw:birthDateRaw,birth_date:validBirthDate(birthDateRaw,birthYear),island_raw:island,club_name_raw:clubName,relation_raw:relation,entity_kind:structure.entity_kind,person_components:structure.person_components};
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

function inferShortYear(from,shortYear){
  const century=Math.floor(from/100)*100;let value=century+Number(shortYear);if(value<from)value+=100;return value;
}

function parseRegistryPeriods(raw){
  return String(raw||'').split(',').map(part=>part.trim()).filter(Boolean).map(part=>{
    const exact=part.match(/^(\d{4})$/);if(exact)return {raw:part,kind:'year',from:Number(exact[1]),to:Number(exact[1]),from_open:false,to_open:false};
    const closed=part.match(/^(\d{4})\s*[-–—]\s*(\d{2}|\d{4})$/);if(closed){const from=Number(closed[1]);const to=closed[2].length===2?inferShortYear(from,closed[2]):Number(closed[2]);return {raw:part,kind:'range',from,to,from_open:false,to_open:false}}
    const openStart=part.match(/^[-–—]\s*(\d{4})$/);if(openStart)return {raw:part,kind:'range',from:null,to:Number(openStart[1]),from_open:true,to_open:false};
    const openEnd=part.match(/^(\d{4})\s*[-–—]$/);if(openEnd)return {raw:part,kind:'range',from:Number(openEnd[1]),to:null,from_open:false,to_open:true};
    return {raw:part,kind:'text',from:null,to:null,from_open:false,to_open:false};
  });
}

function parseBoatComponent(raw,order){
  const text=String(raw||'').replace(/\s+/g,' ').replace(/[.;,]+$/,'').trim();
  const prefix=text.match(/^(M\/S|S\/S|R\/S|P\/S)\s*/i)?.[1]?.toUpperCase()||'';
  let name=text.replace(/^(?:M\/S|S\/S|R\/S|P\/S)\s*/i,'').trim();
  const yearMatch=name.match(/\s*\(([^()]*(?:\d{2,4})[^()]*)\)\s*$/);
  const registryYearRaw=yearMatch?.[1]?.trim()||'';
  if(yearMatch)name=name.slice(0,yearMatch.index).trim();
  const registryPeriods=parseRegistryPeriods(registryYearRaw);
  const registryYears=[...new Set(registryPeriods.flatMap(period=>[period.from,period.to]).filter(Number.isInteger))];
  return {order,raw_text:text,prefix,boat_name_raw:name,registry_year_raw:registryYearRaw,registry_year:/^\d{4}$/.test(registryYearRaw)?Number(registryYearRaw):null,registry_years:registryYears,registry_periods:registryPeriods};
}

function validate(document){
  const topKeys=['schema_version','document','release','columns','sections','member_rows','boat_rows','layout_rows','document_notes'];
  if(JSON.stringify(Object.keys(document))!==JSON.stringify(topKeys))throw new Error(`Fel toppnivåformat: ${document.document?.id||'okänt dokument'}`);
  if(document.schema_version!==2)throw new Error(`Fel schemaversion: ${document.document.id}`);
  for(const key of ['id','label','source_type','is_primary_for_release','original_files'])if(!(key in document.document))throw new Error(`Dokumentfält saknas (${key}): ${document.document.id}`);
  for(const key of ['id','year','as_of','title','release_type','sort_order'])if(!(key in document.release))throw new Error(`Utgåvefält saknas (${key}): ${document.document.id}`);
  const ids=new Set();
  for(const row of document.member_rows){
    if(JSON.stringify(Object.keys(row))!==JSON.stringify(MEMBER_KEYS))throw new Error(`Medlemsrad har osynkat format: ${row.id}`);
    if(ids.has(row.id))throw new Error(`Dubbelrad: ${row.id}`);ids.add(row.id);
  }
  for(const row of document.boat_rows){
    if(JSON.stringify(Object.keys(row))!==JSON.stringify(BOAT_KEYS))throw new Error(`Båtrad har osynkat format: ${row.id}`);
    if(ids.has(row.id))throw new Error(`Dubbelrad: ${row.id}`);ids.add(row.id);
    for(const component of row.components)if(JSON.stringify(Object.keys(component))!==JSON.stringify(COMPONENT_KEYS))throw new Error(`Båtkomponent har osynkat format: ${row.id}`);
  }
  for(const row of document.layout_rows)if(JSON.stringify(Object.keys(row))!==JSON.stringify(LAYOUT_KEYS))throw new Error(`Layoutrad har osynkat format: ${row.id}`);
  return document;
}

async function fileInfo(originalFilename,canonicalFilename,extra={}){
  const sourcePath=resolve(SOURCE_ROOT,originalFilename);
  const bytes=await readFile(sourcePath);
  const targetPath=resolve(ORIGINALS,canonicalFilename);
  await copyFile(sourcePath,targetPath);
  return {original_filename:originalFilename,canonical_filename:canonicalFilename,source_relative_path:`källmaterial/07 KBK-arkivet/Matriklar och Vem-är-vem/${originalFilename}`,private_copy:`privat/kallkopior/matriklar/original/${canonicalFilename}`,sha256:sha256(bytes),bytes:bytes.length,mime_type:extname(originalFilename).toLowerCase()==='.pdf'?'application/pdf':extname(originalFilename).toLowerCase()==='.txt'?'text/plain; charset=utf-8':extname(originalFilename).toLowerCase()==='.jpg'?'image/jpeg':'image/heic',...extra};
}

function releaseFromFilename(filename,text){
  const match=filename.match(/Vem är vem (\d{4})(?:-(\d{2})-(\d{2}))?/i);
  if(!match)throw new Error(`Kan inte datera ${filename}`);
  let asOf=match[1];
  if(match[2])asOf+=`-${match[2]}-${match[3]}`;
  if(!match[2]){
    const headerDate=text.slice(0,700).normalize('NFC').match(/(?:UPPDATERAD|FÖRNAMN|EFTERNAMN|ÅLDER|FÖDELSEÅR|FÖDELSEDATUM|KBK-NAMN|RELATION)\s*(20\d{6})\b/i)?.[1];
    if(headerDate)asOf=`${headerDate.slice(0,4)}-${headerDate.slice(4,6)}-${headerDate.slice(6,8)}`;
  }
  const isUndated2025Standard=match[1]==='2025'&&asOf==='2025'&&!filename.includes('Numbers-export');
  return {id:isUndated2025Standard?'matrikel-2025-standard':asOf===match[1]?`matrikel-${match[1]}`:`matrikel-${asOf}`,year:Number(match[1]),as_of:asOf,as_of_precision:asOf.length===4?'year':'day',title:isUndated2025Standard?'Vem är vem? – 2025 (standardexport, exakt datum okänt)':`Vem är vem? – ${asOf}`,release_type:'vem-ar-vem'};
}

function sortOrder(filename){
  filename=filename.normalize('NFC');
  for(const [needle,value] of [['Förnamn','förnamn'],['Efternamn','efternamn'],['Födelseår','födelseår'],['Födelsedatum','födelsedatum'],['KBK-namn','kbk-namn'],['Relation','relation'],['Ålder','ålder'],['– Ö','ö'],['KBK-snurra','kbk-snurra'],['Numbers-export','numbers-export']])if(filename.includes(needle))return value;
  return 'källordning';
}

function findHeader(lines){
  for(const line of lines){
    const normalized=line.normalize('NFC');
    if(/FÖRNAMN/i.test(normalized)&&/EFTERNAMN/i.test(normalized)){
      const relationMatch=normalized.match(/Hör till|Hemma hos|FAMILJ/i);
      const clubMatch=normalized.match(/KBK-namn|BÅTKLUBBSNAMN/i);
      return {line,relationStart:relationMatch?.index??null,clubStart:clubMatch?.index??-1};
    }
  }
  return {line:'',relationStart:null,clubStart:null};
}

function continuationAllowed(line){
  const value=line.trim();
  return value&&!/KORPHOLMENS BÅTKLUBB|VEM ÄR VEM|Förnamn|Efternamn|Fyller|I år|Född|KBK-namn|Hemma hos|Hör till|^\d+\s*$/.test(value);
}

function looksLikeModernRow(line){
  const parts=String(line||'').trim().split(/\s{2,}/).filter(Boolean);
  if(/^\d{1,3}$/.test(parts[0]||'')&&parts.slice(1).some(part=>/^(?:19|20)\d{2}$/.test(part)))return true;
  if(/^\d{4}$/.test(parts[0]||'')&&/^\d{1,3}$/.test(parts[1]||'')&&/^(?:19|20)\d{2}$/.test(parts[2]||''))return true;
  return parts.some(part=>/^(?:19|20)\d{6}$/.test(part));
}

function currentSnapshotText(text){
  const matches=[...text.normalize('NFC').matchAll(/KORPHOLMENS\s+BÅTKLUBB/gi)];
  return matches.length>1?text.slice(0,matches[1].index):text;
}

function parseModernRows(text,documentId,releaseId){
  const rows=[];const pages=text.split('\f');
  pages.forEach((pageText,pageIndex)=>{
    const lines=pageText.split(/\r?\n/);const header=findHeader(lines);
    for(let index=0;index<lines.length;index+=1){
      const raw=lines[index].replace(/\s+$/,'');
      const parts=raw.trim().split(/\s{2,}/).filter(Boolean);
      let parsed=null;
      const birthDateIndex=parts.findIndex(part=>/^\d{8}$/.test(part));
      const yearIndex=parts.findIndex((part,partIndex)=>partIndex>0&&/^\d{4}$/.test(part));
      if(/^\d{4}$/.test(parts[0]||'')&&/^\d{1,3}$/.test(parts[1]||'')&&/^(?:19|20)\d{2}$/.test(parts[2]||'')&&parts.length>=5){
        const birthDateRaw=parts[0];const ageRaw=parts[1];const birthYearRaw=parts[2];const firstName=parts[3];const lastName=parts[4];const tail=parts.slice(5);
        let relation='';
        if(header.relationStart!==null&&raw.length>header.relationStart)relation=raw.slice(header.relationStart).trim();
        const island=tail.find(part=>ISLANDS.has(part))||'';
        const remaining=tail.filter(part=>part!==island&&part!==relation);
        let clubName='';
        if(header.relationStart!==null&&header.clubStart>=0&&raw.length>header.clubStart)clubName=raw.slice(header.clubStart,header.relationStart).trim();
        else clubName=remaining.find(part=>/^(?:Broder|Syster|S\.?)/i.test(part))||remaining.join(' ');
        if(!relation)relation=remaining.filter(part=>part!==clubName).join(' ');
        parsed={firstName,lastName,birthYearRaw,birthDateRaw,island,clubName,relation,ageRaw};
      }else if(birthDateIndex>=2&&!/^\d{1,3}$/.test(parts[0]||'')){
        const firstName=parts.slice(0,birthDateIndex-1).join(' ');const lastName=parts[birthDateIndex-1];const birthDateRaw=parts[birthDateIndex];const birthYearRaw=birthDateRaw.slice(0,4);
        const tail=parts.slice(birthDateIndex+1);const island=tail.find(part=>ISLANDS.has(part))||'';
        const clubName=tail.filter(part=>part!==island).join(' ');
        parsed={firstName,lastName,birthYearRaw,birthDateRaw,island,clubName,relation:'',ageRaw:''};
      }else if(/^\d{1,3}$/.test(parts[0]||'')&&yearIndex>=3){
        const ageRaw=parts[0];const firstName=parts.slice(1,yearIndex-1).join(' ');const lastName=parts[yearIndex-1];const birthYearRaw=parts[yearIndex];
        const tail=[...parts.slice(yearIndex+1)];let birthDateRaw='';
        if(/^\d{8,9}$/.test(tail[0]||''))birthDateRaw=tail.shift();
        let relation='';
        if(header.relationStart!==null&&raw.length>header.relationStart){relation=raw.slice(header.relationStart).trim();if(relation)tail.splice(tail.lastIndexOf(relation),1)}
        const island=tail.find(part=>ISLANDS.has(part))||'';
        const remaining=tail.filter(part=>part!==island&&part!==relation);
        let clubName='';
        if(header.relationStart!==null&&header.clubStart>=0&&raw.length>header.clubStart)clubName=raw.slice(header.clubStart,header.relationStart).trim();
        else clubName=remaining.find(part=>/^(?:Broder|Syster|S\.?)/i.test(part))||remaining.join(' ');
        if(!relation)relation=remaining.filter(part=>part!==clubName).join(' ');
        parsed={firstName,lastName,birthYearRaw,birthDateRaw,island,clubName,relation,ageRaw};
      }
      if(!parsed||!parsed.firstName||!parsed.lastName)continue;
      let rawText=raw;let continuation='';let lookahead=index+1;
      while(lookahead<lines.length&&!lines[lookahead].trim())lookahead+=1;
      if(lookahead<lines.length&&continuationAllowed(lines[lookahead])&&!looksLikeModernRow(lines[lookahead])){
        continuation=lines[lookahead].trim();rawText+=`\n${lines[lookahead].replace(/\s+$/,'')}`;index=lookahead;
      }
      if(continuation){if(parsed.relation)parsed.relation+=` ${continuation}`;else if(parsed.clubName.endsWith('-'))parsed.clubName+=continuation;else parsed.relation=continuation}
      const personName=`${parsed.firstName} ${parsed.lastName}`.replace(/\s+/g,' ').trim();
      rows.push(blankMember({id:`member-row:${documentId}:${pad(rows.length+1)}`,order:rows.length+1,page:pageIndex+1,category:'listed',rawText,firstName:parsed.firstName,lastName:parsed.lastName,personName,ageRaw:parsed.ageRaw,birthYearRaw:parsed.birthYearRaw,birthDateRaw:parsed.birthDateRaw,island:parsed.island,clubName:parsed.clubName,relation:parsed.relation}));
    }
  });
  if(!rows.length)throw new Error(`Inga medlemsrader hittades i ${documentId}`);
  return rows;
}

function primaryRank(document){
  const order=document.release.sort_order;
  return {'ålder':100,'födelsedatum':90,'födelseår':80,'källordning':70,'numbers-export':60,'kbk-snurra':50,'förnamn':40,'efternamn':30,'ö':20,'kbk-namn':10,'relation':0}[order]??-1;
}

async function buildModernDocuments(){
  const names=(await readdir(SOURCE_ROOT)).filter(name=>/^Vem är vem .*\.pdf$/i.test(name.normalize('NFC'))).sort((a,b)=>a.localeCompare(b,'sv'));
  const hashes=new Map();
  for(const name of names){const bytes=await readFile(resolve(SOURCE_ROOT,name));const hash=sha256(bytes);if(!hashes.has(hash))hashes.set(hash,[]);hashes.get(hash).push(name)}
  const documents=[];
  for(const aliases of hashes.values()){
    const preferred=aliases.find(name=>!name.normalize('NFC').includes('Susannas exemplar'))||aliases[0];
    const preferredLabel=preferred.normalize('NFC');
    const {stdout:text}=await execFileAsync(PDFTOTEXT,['-layout',resolve(SOURCE_ROOT,preferred),'-'],{maxBuffer:20_000_000});
    const release=releaseFromFilename(preferredLabel,text);const order=sortOrder(preferredLabel);
    release.sort_order=order;
    const suffix=order==='källordning'?'standard':slug(order);
    const documentId=`source-document:${release.id}:${suffix}`;
    const canonicalBase=`vem-ar-vem-${release.as_of}-${suffix}`;
    const originalFiles=[];
    for(const [aliasIndex,name] of aliases.entries())originalFiles.push(await fileInfo(name,`${canonicalBase}.pdf`,{role:aliasIndex?'byte-identisk dubblett':'original',page:null}));
    const base=preferred.replace(/\.pdf$/i,'');
    const extractNames=(await readdir(SOURCE_ROOT)).filter(name=>name===`${base} (textextrakt).txt`);
    for(const name of extractNames)originalFiles.push(await fileInfo(name,`${canonicalBase}-textextrakt.txt`,{role:'läskopia',page:null}));
    const snapshotText=currentSnapshotText(text);
    const memberRows=parseModernRows(snapshotText,documentId,release.id);
    documents.push({schema_version:1,document:{id:documentId,label:preferredLabel.replace(/\.pdf$/i,''),source_type:'PDF-export av Vem är vem',is_primary_for_release:false,transcription_method:'strukturerad tolkning av PDF-textlagret',transcription_status:'maskinellt parserad och radkontrollerad',original_files:originalFiles},release,columns:[{id:'age',label_raw:'I år/Fyller i år'},{id:'first_name',label_raw:'Förnamn'},{id:'last_name',label_raw:'Efternamn'},{id:'birth_year',label_raw:'Född/Födelseår'},{id:'birth_date',label_raw:'Födelsedatum'},{id:'island',label_raw:'Ö'},{id:'club_name',label_raw:'KBK-namn'},{id:'relation',label_raw:'Hör till/Hemma hos'}],sections:[{id:`section:${documentId}:listed`,kind:'member',category:'listed',label_raw:'Vem är vem',page:1,start_order:1,end_order:memberRows.length}],member_rows:memberRows,boat_rows:[],document_notes:[...(snapshotText.length<text.length?['PDF-filen innehåller även äldre, inbäddade sorteringsbilagor. De finns kvar i arkivoriginalet men räknas inte som personer i denna utgåva.']:[])]});
  }
  const byYear=new Map();
  for(const document of documents){const year=document.release.year;if(!byYear.has(year))byYear.set(year,[]);byYear.get(year).push(document)}
  const selected=[];
  for(const [year,variants] of byYear){
    const ranked=variants.slice().sort((a,b)=>primaryRank(b)-primaryRank(a)||String(b.release.as_of).localeCompare(String(a.release.as_of),'sv')||b.member_rows.length-a.member_rows.length||a.document.id.localeCompare(b.document.id,'sv'));
    const chosenSource=ranked[0];
    const chosen=structuredClone(chosenSource);
    const selectedSourceDocumentId=chosen.document.id;
    const selectedSourceReleaseId=chosen.release.id;
    const annualReleaseId=`matrikel-${year}`;
    const annualDocumentId=`source-document:${annualReleaseId}:arsutgava`;
    chosen.document.id=annualDocumentId;
    chosen.document.label=`Vem är vem ${year}`;
    chosen.document.is_primary_for_release=true;
    chosen.document.selected_source_document_id=selectedSourceDocumentId;
    chosen.document.selected_source_release_id=selectedSourceReleaseId;
    chosen.document.original_files=variants.flatMap(variant=>variant.document.original_files.map(file=>({...file,source_release_id:variant.release.id,source_as_of:variant.release.as_of,source_sort_order:variant.release.sort_order,selected_for_annual_json:variant===chosenSource})));
    chosen.release.id=annualReleaseId;
    chosen.release.title=`Vem är vem? – ${year}`;
    chosen.release.annual_policy='en matrikel per kalenderår';
    chosen.member_rows=chosen.member_rows.map(row=>({...row,id:`member-row:${annualDocumentId}:${pad(row.order)}`}));
    chosen.sections=chosen.sections.map(section=>({...section,id:`section:${annualDocumentId}:listed`,end_order:chosen.member_rows.length}));
    chosen.document_notes.unshift(`En årsvis JSON lagras för ${year}. Vald källåtergivning: ${chosen.release.as_of}, ordning ${chosen.release.sort_order}. Ålder eller födelsedatum prioriteras, därefter standardåtergivning och senaste tillgängliga källdatum.`);
    if(variants.length>1)chosen.document_notes.push(`Samtliga ${variants.length} PDF-/exportvarianter för året finns kvar med filnamn och SHA-256 i document.original_files; de skapar inte egna matrikelutgåvor.`);
    selected.push(chosen);
  }
  return selected;
}

function pageForPerson(release,status,index){
  let remaining=index;
  for(const span of release.people_pages?.[status]||[]){if(remaining<span.count)return span.page;remaining-=span.count}
  return null;
}

async function build1991And1998(){
  const legacy=JSON.parse(await readFile(LEGACY_1991_1998,'utf8'));const documents=[];
  for(const releaseSource of legacy.releases){
    const documentId=`source-document:${releaseSource.id}:foto`;let order=0;const memberRows=[];
    for(const category of ['active','passive','junior','corresponding'])for(const [index,raw] of (releaseSource.people?.[category]||[]).entries()){
      order+=1;const match=String(raw).match(/^\s*(?:(\d{4}\??)\s+)?(.+?)\s*$/);const parsed=historicName(match?.[2]||raw);
      const annotation=releaseSource.people_annotations?.find(item=>item.raw_text===raw)?.annotation||'';
      memberRows.push(blankMember({id:`member-row:${documentId}:${pad(order)}`,order,page:pageForPerson(releaseSource,category,index),category,rawText:raw,annotation,inductionYearRaw:match?.[1]||'',personName:parsed.personName,clubCore:parsed.clubCore}));
    }
    const boatRows=releaseSource.boat_rows.map((row,index)=>({id:`boat-row:${documentId}:${pad(index+1)}`,order:index+1,page:row.page??null,category:row.category,raw_text:row.raw_text||'',source_annotation:row.annotation||'',components:(row.components||splitOutsideParentheses(row.raw_text||'')).map((component,componentIndex)=>parseBoatComponent(component,componentIndex+1))}));
    const files=[];
    for(const source of legacy.source_files.filter(file=>file.year===releaseSource.year))files.push(await fileInfo(source.filename,`medlemsmatrikel-${releaseSource.year}-sida-${source.page}.heic`,{role:'original',page:source.page}));
    documents.push({schema_version:1,document:{id:documentId,label:releaseSource.title,source_type:'fotografier av maskinskriven medlemsmatrikel',is_primary_for_release:true,transcription_method:'manuellt kontrollerad bildavskrift',transcription_status:'kontrollerad mot samtliga fotograferade sidor',original_files:files},release:{id:releaseSource.id,year:releaseSource.year,as_of:releaseSource.as_of,as_of_precision:'month',title:releaseSource.title,release_type:'medlemsmatrikel',sort_order:'källordning',source_date:releaseSource.source_date||null,source_signature:releaseSource.source_signature||null},columns:[{id:'induction_year',label_raw:'INV. ÅR'},{id:'member_name',label_raw:'MEDLEMMAR'},{id:'registered_vessel',label_raw:'INREG. FARTYG'}],sections:Object.entries(releaseSource.people||{}).map(([category,rows])=>({id:`section:${documentId}:${category}`,kind:'member',category,label_raw:category,page:null,start_order:null,end_order:rows.length})),member_rows:memberRows,boat_rows:boatRows,document_notes:['Äldre avskriftsunderlag bevarat oförändrat; detta dokument är den synkade schema-versionen.']});
  }
  return documents;
}

async function build2010(){
  const documentId='source-document:matrikel-2010:foto';
  const sourceRows=[
    [1,'1953','Pyn','Per-Olof'],
    [1,'1953','Inger'],
    [1,'1957','Sten','Sten-Algot'],
    [1,'1957','Karin'],
    [1,'1959','Bo Pederby','Bo-Bättre','Passiv'],
    [1,'1959','Barbro Pederby','','Passiv'],
    [1,'1961','Gunnel Risinger'],
    [1,'1965','Niquel','Niquel-Elvis'],
    [1,'1965','Maggan'],
    [1,'1977','Bosse','Bo-Alexander'],
    [1,'1977','Karl-Rune'],
    [1,'1977','Svante-Karl-Oskar'],
    [1,'1977','Britt-Marie'],
    [1,'1977','Mats','Karl-Mats'],
    [1,'1977','Pär','Karl-Pär'],
    [1,'1978','Johan','Johan-Anders'],
    [1,'1979','Lotta'],
    [1,'1979','Karin Åkerlund'],
    [1,'1980','Nalle','Nalle-Björn'],
    [1,'1980','Klas','Klas-Allan'],
    [1,'1981','Agneta'],
    [1,'1982','Birgitta Pederby','','Ordinarie Passiv medlem'],
    [1,'1982','Henrik Pederby','Henrik-Gonzales','Ordinarie Passiv medlem'],
    [1,'1983','Anna'],
    [1,'1983','Anders-Sören'],
    [1,'1983','Viveka'],
    [1,'1984','Marianne'],
    [1,'1984','Ella'],
    [1,'1984','Laila'],
    [1,'1984','Monika Ekström'],
    [1,'1984','Björn','Björn-Tor'],
    [1,'1985','Janne','Jan-Bison'],
    [1,'1986','Mia'],
    [1,'1986','Nisse','Nisse-Nisse'],
    [1,'1986','Peter Neretnieks'],
    [1,'1987','Göran','Göran-Teobald'],
    [1,'1988','Kaj','Kaj-Gunder'],
    [1,'1988','Lisa'],
    [1,'1988','Helene'],
    [1,'1988','Sussen'],
    [1,'1988','Pinglan'],
    [1,'1988','Tesse'],
    [1,'1989','Åke Lindbom','Åke-Fredrik'],
    [1,'1989','Karin Bergström'],
    [1,'1990','Thomas','Thomas-Anders'],
    [1,'1992','Jenny Ödlund-Åkerman'],
    [1,'1994','Kjelle','Kjell-Madicken'],
    [1,'1995','Bertil','Tyko-Bertil','Ordinarie Passiv medlem'],
    [1,'1995','Caj','','Ordinarie Passiv medlem'],
    [1,'1996','Benke','Bengt-Lattjo'],
    [1,'1998','HenrikTunborg','Henrik-Henrik'],
    [2,'1998','Carina Tunborg'],
    [2,'1999','Charlotte Jonasson'],
    [2,'1999','Gunilla Hedström'],
    [2,'2003','Håkan Leczinski','Håkan-Bill','Död 2010'],
    [2,'2005','Anders Åhlin','Mac-Anders'],
    [2,'2005','Kerstin Dalaryd'],
    [2,'2008','Timo','Tim-Jan'],
    [2,'19??','Janne','Jan-Viktor'],
    [2,'19??','Lena'],
    [2,'19??','Jossan','Johan-Gunder'],
    [2,'19??','Annika Löfqvist'],
    [2,'19??','Hasse','Hans-Allan','Död 2010'],
    [2,'19??','Kisse'],
    [2,'19??','Mark','Mark-Gunnar'],
    [2,'19??','Annika Une'],
    [2,'19??','Görvel'],
    [2,'1945?','Bibbi','','Död 1997'],
    [2,'1945?','Carl-Henrik Norlander','','Ordinarie Passiv medlem'],
    [2,'1945?','Per-Axel Weslien','','Ordinarie Passiv medlem'],
    [2,'1955?','Petter','Karl-Petter'],
    [2,'20??','Mats Nilsson'],
    [2,'1995','Holger Thufvesson','','Korresponderande medlem'],
    [2,'1995','Ditte Tufvesson','','Korresponderande medlem'],
    [2,'2010','Carlo','Carl-Norskar'],
    [2,'2010','Filip','Filip-Film'],
    [2,'2010','Måns','Måns-Viktor'],
  ];
  const rawText=cells=>{const values=[...cells];while(values.at(-1)==='')values.pop();return values.join('\t')};
  const categoryFor=note=>note.includes('Korresponderande')?'corresponding':note.includes('Passiv')?'passive':note.startsWith('Död')?'listed':'active';
  const memberRows=sourceRows.map(([page,year,name,club='',note=''],index)=>blankMember({
    id:`member-row:${documentId}:${pad(index+1)}`,
    order:index+1,
    page,
    category:categoryFor(note),
    rawText:rawText([year,name,club,note]),
    inductionYearRaw:year,
    personName:name,
    clubCore:club,
  }));
  const files=await Promise.all([
    fileInfo('IMG_7400.HEIC','medlemsmatrikel-2010-sida-1.heic',{role:'original',page:1}),
    fileInfo('IMG_7401.HEIC','medlemsmatrikel-2010-sida-2.heic',{role:'original',page:2}),
  ]);
  return {
    schema_version:1,
    document:{
      id:documentId,
      label:'Medlemsmatrikel 2010 – Tabell1',
      source_type:'fotografier av maskinskriven medlemsmatrikel',
      is_primary_for_release:true,
      transcription_method:'manuellt kontrollerad bildavskrift',
      transcription_status:'kontrollerad mot samtliga fotograferade sidor',
      original_files:files,
    },
    release:{
      id:'matrikel-2010',
      year:2010,
      as_of:'2010',
      as_of_precision:'year',
      title:'Medlemsmatrikel 2010',
      release_type:'medlemsmatrikel',
      sort_order:'källordning',
      source_date:null,
      source_signature:null,
    },
    columns:[
      {id:'induction_year',label_raw:''},
      {id:'member_name',label_raw:''},
      {id:'club_name_core',label_raw:''},
      {id:'note',label_raw:''},
    ],
    sections:[{id:`section:${documentId}:tabell1`,kind:'member',category:'mixed',label_raw:'Tabell1',page:null,start_order:1,end_order:memberRows.length}],
    member_rows:memberRows,
    boat_rows:[],
    document_notes:[
      'Årtalet 2010 är handskrivet på sida 1; den tryckta tabellen saknar dateringsrad.',
      'Tabellens fyra visuella kolumner bevaras tabulatorseparerade i raw_text. Stavningar, frågetecken och anmärkningar återges som i källan.',
      'Källan har ingen separat fartygskolumn och ger därför inga båt- eller ägarobservationer.',
    ],
  };
}

async function hydrateHistorical(document){
  const originalFiles=[];
  for(const file of document.document.original_files){originalFiles.push(await fileInfo(file.original_filename,file.canonical_filename,{role:file.role||'original',page:file.page??null}))}
  document.document.original_files=originalFiles;
  return document;
}

function enrichMemberRow(row){
  const structure=personStructure(row.person_name_raw,row.category);
  return {
    id:row.id,order:row.order,page:row.page??null,category:row.category,raw_text:row.raw_text||'',source_annotation:row.source_annotation||'',
    induction_year_raw:row.induction_year_raw||'',induction_year:row.induction_year??null,first_name_raw:row.first_name_raw||'',last_name_raw:row.last_name_raw||'',
    person_name_raw:row.person_name_raw||'',club_name_core_raw:row.club_name_core_raw||'',age_raw:row.age_raw||'',birth_year_raw:row.birth_year_raw||'',
    birth_year:row.birth_year??null,birth_date_raw:row.birth_date_raw||'',birth_date:row.birth_date??null,island_raw:row.island_raw||'',
    club_name_raw:row.club_name_raw||'',relation_raw:row.relation_raw||'',entity_kind:structure.entity_kind,person_components:structure.person_components,
  };
}

function enrichDocument(source){
  const memberRows=source.member_rows.map(enrichMemberRow);
  const anchors=BOAT_MEMBER_ANCHORS[source.release.year]||{};
  const boatRows=source.boat_rows.map(row=>{
    const correct1998Babb=value=>source.release.year===1998&&row.order===62?String(value||'').replace('M/S Babbb','M/S Babb'):String(value||'');
    return {
      id:row.id,order:row.order,page:row.page??null,category:row.category,raw_text:correct1998Babb(row.raw_text),source_annotation:row.source_annotation||'',
      components:(row.components||[]).map(component=>parseBoatComponent(correct1998Babb(component.raw_text),component.order)),
      associated_member_row_id:anchors[row.order]?memberRows.find(member=>member.order===anchors[row.order])?.id||null:null,
    };
  });
  const exactSections=exactLegacySections(source.document.id,source.release.year,memberRows);
  const sections=(exactSections||source.sections).map(section=>({...section,note_raw:section.note_raw??(section.kind==='member'&&section.category==='corresponding'?CORRESPONDING_NOTE:'')}));
  const note='Källans radlayout lagras separat: båtrader är förankrade vid den tryckta medlemsrad de står bredvid. Förankringen är inte ett ägarpåstående.';
  const document={
    schema_version:2,document:source.document,release:source.release,columns:source.columns,sections,member_rows:memberRows,boat_rows:boatRows,layout_rows:[],
    document_notes:[...source.document_notes,...(source.release.year<=1998&&!source.document_notes.includes(note)?[note]:[])],
  };
  document.layout_rows=buildLayoutRows(document);
  return document;
}

await mkdir(OUTPUT,{recursive:true});await mkdir(ORIGINALS,{recursive:true});
const documents=[];
if(HISTORICAL_INPUT){const input=JSON.parse(await readFile(resolve(HISTORICAL_INPUT),'utf8'));if(!Array.isArray(input))throw new Error('--historical måste peka på en JSON-array.');for(const document of input)documents.push(await hydrateHistorical(document))}
else{
  const existingFiles=(await readdir(OUTPUT)).filter(file=>/^matrikel-(?:1980|1982|1986|1987|1988)\.json$/.test(file)).sort();
  if(existingFiles.length!==5)throw new Error(`Fem befintliga historiska JSON-underlag krävs när --historical saknas; hittade ${existingFiles.length}.`);
  for(const file of existingFiles)documents.push(await hydrateHistorical(JSON.parse(await readFile(resolve(OUTPUT,file),'utf8'))));
}
documents.push(...await build1991And1998());
documents.push(await build2010());
documents.push(...await buildModernDocuments());

for(let index=0;index<documents.length;index+=1)documents[index]=enrichDocument(documents[index]);

const names=new Set();const primaryByRelease=new Map();
for(const document of documents){
  validate(document);
  const filename=`matrikel-${document.release.year}.json`;
  if(names.has(filename))throw new Error(`Dubbel JSON-fil: ${filename}`);names.add(filename);
  if(document.document.is_primary_for_release){if(primaryByRelease.has(document.release.id))throw new Error(`Flera primärdokument: ${document.release.id}`);primaryByRelease.set(document.release.id,document.document.id)}
  await writeFile(resolve(OUTPUT,filename),`${JSON.stringify(document,null,2)}\n`);
}
let pruned=0;
for(const file of (await readdir(OUTPUT)).filter(file=>/^matrikel-.*\.json$/.test(file)))if(!names.has(file)){await unlink(resolve(OUTPUT,file));pruned+=1}
const releaseIds=[...new Set(documents.map(document=>document.release.id))];
for(const releaseId of releaseIds)if(!primaryByRelease.has(releaseId))throw new Error(`Primärdokument saknas: ${releaseId}`);
console.log(`Matrikel-JSON byggd: ${documents.length} källdokument, ${releaseIds.length} utgåvor, ${documents.reduce((sum,document)=>sum+document.member_rows.length,0)} strukturerade medlemsrader och ${documents.reduce((sum,document)=>sum+document.boat_rows.length,0)} båtrader. ${pruned} inaktuella sorteringsvarianter togs bort.`);
