import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { materialize, validateBatch } from '../../../packages/core/data-layer.js';

const requestedRoot=process.argv[2];
if(!requestedRoot)throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

async function materializedMaster(app){
  const root=resolve(dropboxRoot,app,'ops');
  const files=(await readdir(root)).filter(file=>file.endsWith('.json')).sort();
  const batches=await Promise.all(files.map(async file=>{
    const batch=JSON.parse(await readFile(resolve(root,file),'utf8'));
    validateBatch(batch);
    return batch;
  }));
  return materialize(batches.flatMap(batch=>batch.ops));
}

const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const textValues=values=>[...new Set((values||[]).flat().map(value=>String(value||'').trim()).filter(Boolean))];
const boatNames=boat=>textValues([boat.namn,boat.onskat_namn,boat.dopnamn,boat.smeknamn||[],boat.tidigare_namn||[],boat.senare_namn||[]]);
const displayName=boat=>boat.namn||boat.onskat_namn||boat.modell||boat.id;
const effectiveResultName=result=>result.boat_name_corrected||result.boat_name_raw||'';

const [raceMaster,boatMaster]=await Promise.all([materializedMaster('korpholmenrunt'),materializedMaster('batregister')]);
const results=raceMaster.listEntities('race-result').map(entity=>({id:entity.entity_id,...entity.fields}));
const boats=boatMaster.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));
const boatById=new Map(boats.map(boat=>[boat.id,boat]));
const aliasIndex=new Map();
for(const boat of boats)for(const name of boatNames(boat)){
  const key=normalize(name);
  if(!key)continue;
  if(!aliasIndex.has(key))aliasIndex.set(key,new Set());
  aliasIndex.get(key).add(boat.id);
}
const exactIds=result=>[...(aliasIndex.get(normalize(effectiveResultName(result)))||[])];

const linked=results.filter(result=>result.boat_id);
const invalidLinks=linked.filter(result=>!boatById.has(result.boat_id));
const exactContradictions=linked.filter(result=>{const candidates=exactIds(result);return candidates.length&&!candidates.includes(result.boat_id)}).map(result=>({
  result_id:result.id,
  year:result.year,
  displayed_name:effectiveResultName(result),
  linked_id:result.boat_id,
  exact_current_candidates:exactIds(result),
}));
const ambiguousLinked=linked.filter(result=>exactIds(result).length>1).map(result=>({
  result_id:result.id,
  year:result.year,
  displayed_name:effectiveResultName(result),
  linked_id:result.boat_id,
  exact_current_candidates:exactIds(result),
  method:result.boat_match_method,
}));
const unresolved=results.filter(result=>!result.boat_id&&effectiveResultName(result)).map(result=>({
  result_id:result.id,
  year:result.year,
  displayed_name:effectiveResultName(result),
  exact_current_candidates:exactIds(result),
  stored_candidates:result.boat_candidate_ids||[],
}));
const homsanLinks=results.filter(result=>result.boat_id==='homsan');
const homsanDisplayed=results.filter(result=>normalize(effectiveResultName(result))==='homsan');
const mymlanCorrection=results.find(result=>result.id==='race-result:analog-img-7402-2010-02');

const controls={};
for(const term of ['filifjonkan','snusmumriken','kapsylen']){
  const matchingBoats=boats.filter(boat=>boatNames(boat).some(name=>normalize(name).includes(term)));
  const ids=new Set(matchingBoats.map(boat=>boat.id));
  controls[term]={
    boats:matchingBoats.map(boat=>({id:boat.id,name:displayName(boat),type:boat.typ||'',owner:boat.agare||boat.agarnamn||''})),
    linked_results:results.filter(result=>ids.has(result.boat_id)).map(result=>({result_id:result.id,year:result.year,displayed_name:effectiveResultName(result),boat_id:result.boat_id,class_name:result.class_name})),
    unresolved_results:unresolved.filter(result=>normalize(result.displayed_name).includes(term)),
  };
}

const report={
  boats_in_current_master:boats.length,
  race_results:results.length,
  linked_results:linked.length,
  invalid_stable_ids:invalidLinks.map(result=>({result_id:result.id,boat_id:result.boat_id})),
  exact_name_contradictions:exactContradictions,
  ambiguous_linked_results:ambiguousLinked,
  unresolved_results:unresolved.length,
  unresolved_with_exact_candidates:unresolved.filter(result=>result.exact_current_candidates.length).length,
  homsan_result_links:homsanLinks.length,
  homsan_displayed_results:homsanDisplayed.length,
  mymlan_correction:{
    result_id:mymlanCorrection?.id,
    displayed_name:effectiveResultName(mymlanCorrection),
    raw_name:mymlanCorrection?.boat_name_raw,
    boat_id:mymlanCorrection?.boat_id,
    correction_status:mymlanCorrection?.boat_name_correction_status,
  },
  controls,
};
console.log(JSON.stringify(report,null,2));
if(invalidLinks.length||exactContradictions.length||homsanLinks.length||homsanDisplayed.length)process.exitCode=1;
