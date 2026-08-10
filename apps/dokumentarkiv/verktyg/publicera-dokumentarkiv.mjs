import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aterstallArkivering, genomforArkivering, planeraArkivering, skrivArkiveringslogg } from './arkivera-inkorgsoriginal.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PROJECT_ROOT=resolve(REPO,'../../..');
const requestedRoot=process.argv[2];
if(!requestedRoot)throw new Error('Ange Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot=await realpath(resolve(requestedRoot));
if(!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen'))throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

async function latestRemoteClock(){
  const folder=resolve(dropboxRoot,'dokumentarkiv/ops');
  let maximum=0;
  for(const entry of await readdir(folder,{withFileTypes:true})){
    if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
    const batch=JSON.parse(await readFile(resolve(folder,entry.name),'utf8'));
    for(const operation of batch.ops||[]){
      const milliseconds=Number(String(operation.hlc||'').split('-')[0]);
      if(Number.isFinite(milliseconds))maximum=Math.max(maximum,milliseconds);
    }
  }
  return maximum;
}

function run(label,args,env={}){
  console.log(`\n${label}…`);
  const result=spawnSync(process.execPath,args,{cwd:ROOT,env:{...process.env,...env},stdio:'inherit'});
  if(result.status!==0)throw new Error(`${label} misslyckades (${result.status??'okänd status'})`);
}

const nextClock=Math.max(Date.now(),await latestRemoteClock()+1000);
const clockIso=new Date(nextClock).toISOString();
const migrationTag=`${clockIso.slice(0,10)}-publicering-${clockIso.slice(11,19).replaceAll(':','')}`;
const archivePlan=await planeraArkivering({projectRoot:PROJECT_ROOT});
console.log(`Arkiveringsplan: ${archivePlan.moves.length} behandlade original flyttas, ${archivePlan.pending.length} filer stannar i inkorgen.`);
const moved=await genomforArkivering(archivePlan,{writeLog:false});

try{
  const env={
    KORPHOLMEN_PROJEKT_ROOT:PROJECT_ROOT,
    KORPHOLMEN_MIGRATION_TAG:migrationTag,
    KORPHOLMEN_MIGRATION_CLOCK:clockIso,
  };
  run('Bygger aktuell arkivmaster',['verktyg/bygg-startmaster.mjs'],env);
  run('Validerar Dokumentarkivet',['test/harness.mjs'],env);
  run('Publicerar privat master, innehållsbilder och källfiler till Dropbox',['verktyg/skriv-dropbox-startmaster.mjs',dropboxRoot],env);
  await skrivArkiveringslogg(moved,archivePlan.paths.archiveRoot);
  console.log(JSON.stringify({
    migration_tag:migrationTag,
    migration_clock:clockIso,
    archived_inbox_originals:moved.length,
    pending_inbox_files:archivePlan.pending.length,
    dropbox_root:dropboxRoot,
  },null,2));
}catch(error){
  await aterstallArkivering(moved);
  throw error;
}
