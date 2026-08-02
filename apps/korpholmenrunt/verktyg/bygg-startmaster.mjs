import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const SOURCE=resolve(ROOT,'privat/kallkopior/Korpholmen runt konv.mdb');
const OUT=resolve(ROOT,'privat/migrering-2026-08-02');
const PEOPLE=resolve(REPO,'apps/matrikel/privat/migrering-2026-08-01/approved-excel-import.json');
const BOATS=resolve(REPO,'apps/batregister/privat/kallkopior/byggkit/batregister.json');
const DEVICE='migration-korpholmenrunt-2026-08-02';
const REVIEW_DEVICE='migration-korpholmenrunt-granskning-2026-08-02';
const CLOCK_MS=Date.UTC(2026,7,2,20,0,0);

const norm=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>norm(value).replace(/ /g,'');
const array=value=>Array.isArray(value)?value:value?[value]:[];
const unique=values=>[...new Set(values.filter(Boolean))];
const sha256=value=>createHash('sha256').update(value).digest('hex');
const sourceBytes=await readFile(SOURCE);
const sourceHash=sha256(sourceBytes);
const lines=execFileSync('mdb-json',[SOURCE,'Korpholmen runt'],{encoding:'utf8',maxBuffer:32*1024*1024}).trim().split('\n').filter(Boolean);
const rows=lines.map(line=>JSON.parse(line));
const peopleData=JSON.parse(await readFile(PEOPLE,'utf8')).people;
const boatData=JSON.parse(await readFile(BOATS,'utf8')).batar;

const peopleByFull=new Map();
const peopleByFirst=new Map();
for(const person of peopleData){
  const full=norm(person.display_name);
  const first=full.split(' ')[0];
  if(!peopleByFull.has(full))peopleByFull.set(full,[]);
  if(!peopleByFirst.has(first))peopleByFirst.set(first,[]);
  peopleByFull.get(full).push(person);
  peopleByFirst.get(first).push(person);
}

function personMatch(raw){
  const value=String(raw||'').trim();
  const normalized=norm(value);
  if(!normalized||['m fl','-','okand'].includes(normalized))return {status:'saknas',person_id:null,candidates:[]};
  const exact=peopleByFull.get(normalized)||[];
  if(exact.length===1)return {status:'kopplad',person_id:exact[0].id,candidates:[exact[0].id],method:'exakt namn'};
  const words=normalized.split(' ');
  if(words.length===1){
    const first=peopleByFirst.get(words[0])||[];
    if(first.length===1)return {status:'kopplad',person_id:first[0].id,candidates:[first[0].id],method:'entydigt förnamn'};
    if(first.length)return {status:'föreslagen',person_id:null,candidates:first.map(item=>item.id),method:'förnamnskandidater'};
  }
  const candidates=unique(words.flatMap(word=>(peopleByFirst.get(word)||[]).map(item=>item.id)));
  return {status:candidates.length?'föreslagen':'saknas',person_id:null,candidates,method:candidates.length?'namndelar':'ingen träff'};
}

function boatAliases(boat){
  const raw=[boat.namn,boat.smeknamn,boat.dopnamn,...array(boat.tidigare_namn),...array(boat.senare_namn),...array(boat.onskat_namn)];
  return unique(raw.flatMap(value=>String(value||'').split('/')).map(compact));
}
const boatIndex=new Map();
for(const boat of boatData)for(const alias of boatAliases(boat)){
  if(!boatIndex.has(alias))boatIndex.set(alias,[]);
  boatIndex.get(alias).push(boat);
}
function boatMatch(raw){
  const key=compact(raw);
  if(!key||key==='okand'||key==='?')return {status:'saknas',boat_id:null,candidates:[]};
  const exact=unique((boatIndex.get(key)||[]).map(item=>item.id));
  if(exact.length===1)return {status:'kopplad',boat_id:exact[0],candidates:exact,method:'exakt namn/alias'};
  const near=unique([...boatIndex.entries()].filter(([alias])=>alias.length>=4&&(alias.includes(key)||key.includes(alias))).flatMap(([,boats])=>boats.map(item=>item.id))).slice(0,8);
  return {status:near.length?'föreslagen':'saknas',boat_id:null,candidates:near,method:near.length?'namnlikhet':'ingen träff'};
}

function parseTime(raw){
  const value=String(raw||'').trim();
  const match=value.match(/^(\d+)[,.](\d{2})(\?)?$/);
  if(!match)return {duration_seconds:null,time_status:value.endsWith('+')?'minimivärde':'ogiltigt format'};
  const minutes=Number(match[1]);
  const seconds=Number(match[2]);
  if(seconds>59)return {duration_seconds:null,time_status:'ogiltig sekunddel'};
  return {duration_seconds:minutes*60+seconds,time_status:match[3]?'osäker':'tolkad'};
}
function className(raw){
  const value=norm(raw).replace(/[?*]/g,'').trim();
  const names={'segel':'Segel','rodd':'Rodd','kajak 1':'Kajak 1','kajak 2':'Kajak 2','canadian':'Canadian','kanad':'Canadian','ornjolle':'Örnjolle','optimist':'Optimist','gummi':'Gummi','paddel':'Paddel','jolle':'Jolle','rodd segel':'Rodd + segel'};
  return names[value]||String(raw||'Okänd').replace(/[?*]/g,'').trim()||'Okänd';
}
const meaningful=value=>String(value||'').trim()&&!['-','.'].includes(String(value).trim());
const results=[];
const links=[];
const notes=[];
for(const row of rows){
  if(!/^\d{4}$/.test(String(row['År']||''))){notes.push({id:`source-note:${row.ID}`,fields:{source_row_id:row.ID,raw_row:row,note_text:row['Besättning 1']||row.fartyg||'',source_id:'race-source:mdb'}});continue}
  const id=`race-result:mdb-${String(row.ID).padStart(4,'0')}`;
  const time=parseTime(row.tid);
  const boat=boatMatch(row.fartyg);
  const personLinkIds=[];
  for(const [field,role,raw] of [['kapten','Kapten',row.Kapten],['besattning-1','Besättning 1',row['Besättning 1']],['besattning-2','Besättning 2',row['Besättning 2']]]){
    if(!meaningful(raw))continue;
    const match=personMatch(raw);
    const linkId=`race-person-link:mdb-${String(row.ID).padStart(4,'0')}-${field}`;
    personLinkIds.push(linkId);
    links.push({id:linkId,fields:{result_id:id,role,source_field:field,raw_name:raw,person_id:match.person_id,match_status:match.status,match_method:match.method,candidate_ids:match.candidates,confirmed:match.status==='kopplad'}});
  }
  results.push({id,fields:{source_row_id:row.ID,source_id:'race-source:mdb',year:Number(row['År']),boat_name_raw:row.fartyg||'',boat_id:boat.boat_id,boat_match_status:boat.status,boat_match_method:boat.method,boat_candidate_ids:boat.candidates,captain_raw:row.Kapten||'',crew_1_raw:row['Besättning 1']||'',crew_2_raw:row['Besättning 2']||'',class_raw:row.Klass||'',class_name:className(row.Klass),course_code:row.Bana||'',time_raw:row.tid||'',duration_seconds:time.duration_seconds,time_status:time.time_status,person_link_ids:personLinkIds,notes:'',raw_row:row}});
}

const editions=[...new Set(results.map(item=>item.fields.year))].sort((a,b)=>a-b).map(year=>{
  const yearResults=results.filter(item=>item.fields.year===year);
  return {id:`race-edition:${year}`,fields:{year,result_count:yearResults.length,classes:unique(yearResults.map(item=>item.fields.class_name)).sort((a,b)=>a.localeCompare(b,'sv')),course_codes:unique(yearResults.map(item=>item.fields.course_code)).sort(),source_id:'race-source:mdb'}};
});

let seq=0;const operations=[];
function set(entityType,entityId,field,value){seq+=1;operations.push({op_id:`${DEVICE}:${seq}`,device_id:DEVICE,seq,entity_type:entityType,entity_id:entityId,field,value:value===undefined?null:value,hlc:`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`,schema_version:1})}
function add(type,item){for(const [field,value] of Object.entries(item.fields))set(type,item.id,field,value)}
add('race-source',{id:'race-source:mdb',fields:{label:'Korpholmen runt konv.mdb',source_type:'Microsoft Access JET4',source_table:'Korpholmen runt',sha256:sourceHash,original_path:'/Users/simon/Downloads/Korpholmen runt konv.mdb',private_copy:'privat/kallkopior/Korpholmen runt konv.mdb',imported_on:'2026-08-02',row_count:rows.length}});
for(const edition of editions)add('race-edition',edition);
for(const result of results)add('race-result',result);
for(const link of links)add('race-person-link',link);
for(const note of notes)add('source-note',note);
for(const person of peopleData)add('person-ref',{id:`person-ref:${person.id}`,fields:{external_id:person.id,display_name:person.display_name,island:person.island||'',living:person.living||'',url:`../matrikel/?person=${encodeURIComponent(person.id)}`}});
for(const boat of boatData)add('boat-ref',{id:`boat-ref:${boat.id}`,fields:{external_id:boat.id,name:boat.namn,type:boat.typ||'',period:boat.period||'',owner_text:boat.agare||'',url:`../batregister/?boat=${encodeURIComponent(boat.id)}`}});
add('race-root',{id:'race-root:korpholmenrunt',fields:{schema_version:1,migration_id:'korpholmenrunt-2026-08-02',source_sha256:sourceHash,source_rows:rows.length,result_count:results.length,edition_count:editions.length,person_reference_count:peopleData.length,boat_reference_count:boatData.length}});

// Ett unikt förnamn är användbart som kandidat men inte ett verifierat historiskt
// identitetsbelägg. Policyn läggs som en separat, spårbar operationsserie så att
// den ursprungliga importen aldrig skrivs om.
let reviewSeq=0;
function reviewSet(entityType,entityId,field,value){reviewSeq+=1;operations.push({op_id:`${REVIEW_DEVICE}:${reviewSeq}`,device_id:REVIEW_DEVICE,seq:reviewSeq,entity_type:entityType,entity_id:entityId,field,value,hlc:`${CLOCK_MS+60_000}-${String(reviewSeq).padStart(6,'0')}-${REVIEW_DEVICE}`,schema_version:1})}
for(const link of links.filter(item=>item.fields.match_method==='entydigt förnamn')){
  reviewSet('race-person-link',link.id,'match_status','föreslagen');
  reviewSet('race-person-link',link.id,'confirmed',false);
  link.fields.match_status='föreslagen';
  link.fields.confirmed=false;
}

const counts={source_rows:rows.length,results:results.length,editions:editions.length,person_links:links.length,person_links_connected:links.filter(item=>item.fields.match_status==='kopplad').length,person_links_suggested:links.filter(item=>item.fields.match_status==='föreslagen').length,boats_connected:results.filter(item=>item.fields.boat_match_status==='kopplad').length,source_notes:notes.length,people:peopleData.length,boats:boatData.length,operations:operations.length};
await mkdir(OUT,{recursive:true});
await writeFile(resolve(OUT,'initial-ops.json'),`${JSON.stringify({operations_version:1,migration_id:'korpholmenrunt-2026-08-02',device_id:DEVICE,device_ids:[DEVICE,REVIEW_DEVICE],source_sha256:sourceHash,counts,operations},null,2)}\n`);
await writeFile(resolve(OUT,'matchningsrapport.json'),`${JSON.stringify({generated_on:'2026-08-02',counts,unresolved_boats:results.filter(item=>item.fields.boat_match_status!=='kopplad').map(item=>({result_id:item.id,year:item.fields.year,raw:item.fields.boat_name_raw,status:item.fields.boat_match_status,candidates:item.fields.boat_candidate_ids})),unresolved_people:links.filter(item=>item.fields.match_status!=='kopplad').map(item=>({link_id:item.id,raw:item.fields.raw_name,role:item.fields.role,status:item.fields.match_status,candidates:item.fields.candidate_ids}))},null,2)}\n`);
console.log(`Korpholmen runt-master byggd: ${results.length} resultat, ${editions.length} år, ${links.length} deltagarroller, ${operations.length} operationer.`);
