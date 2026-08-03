import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const normalize=value=>String(value||'').normalize('NFC');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=async path=>access(path).then(()=>true,()=>false);

async function childByNfc(parent,wanted){
  const entries=await readdir(parent,{withFileTypes:true});
  const entry=entries.find(item=>normalize(item.name)===normalize(wanted));
  if(!entry)throw new Error(`Kunde inte hitta ${wanted} under ${parent}`);
  return resolve(parent,entry.name);
}

async function walk(folder){
  const result=[];
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const path=resolve(folder,entry.name);
    if(entry.isDirectory())result.push(...await walk(path));
    else if(entry.isFile())result.push(path);
  }
  return result;
}

function cleanCell(value){return String(value||'').trim().replace(/^`|`$/g,'').trim()}

function provenanceRows(text){
  const section=text.split(/\n## Ursprungliga filer\n/)[1]||'';
  const rows=[];
  for(const line of section.split('\n')){
    if(!/^\|.*\|$/.test(line))continue;
    const cells=line.slice(1,-1).split('|').map(cleanCell);
    if(!cells.length||/^(?:Ursprungligt|---)/i.test(cells[0]))continue;
    const expectedHash=cells.map(cell=>cell.match(/\b[a-f0-9]{64}\b/i)?.[0]).find(Boolean);
    if(cells[0]&&cells[1]&&expectedHash)rows.push({incomingName:cells[0],canonicalName:cells[1],expectedHash:expectedHash.toLocaleLowerCase('sv')});
  }
  return rows;
}

async function uniqueTarget(preferred,sha){
  if(!await exists(preferred))return preferred;
  const currentHash=sha256(await readFile(preferred));
  const extension=extname(preferred);
  const stem=preferred.slice(0,-extension.length);
  let index=2;
  while(true){
    const candidate=`${stem} – dubblett ${String(index).padStart(2,'0')}${extension}`;
    if(!await exists(candidate))return candidate;
    if(sha256(await readFile(candidate))===sha)index+=1;
    else index+=1;
  }
}

export async function digitaliseringsvagar(projectRoot){
  const wikiGroup=await childByNfc(projectRoot,'2 Wikis & källor');
  const wikiRoot=await childByNfc(wikiGroup,'Wiki Korpholmen & släkten');
  const digitalRoot=await childByNfc(wikiRoot,'Digitalisering 2026');
  return {
    digitalRoot,
    inboxRoot:await childByNfc(digitalRoot,'00 Inkorg'),
    documentRoot:await childByNfc(digitalRoot,'01 Digitaliserade dokument'),
    archiveRoot:resolve(digitalRoot,'02 Arkiverade inkorgsoriginal'),
  };
}

export async function planeraArkivering({projectRoot}){
  const paths=await digitaliseringsvagar(projectRoot);
  const documentFiles=await walk(paths.documentRoot);
  const transcripts=documentFiles.filter(path=>path.endsWith(' – avskrift.md'));
  const byName=new Map();
  for(const path of documentFiles){
    const key=normalize(basename(path));
    if(!byName.has(key))byName.set(key,[]);
    byName.get(key).push(path);
  }
  const references=new Map();
  for(const transcript of transcripts){
    const text=await readFile(transcript,'utf8');
    const group=relative(paths.documentRoot,transcript).split(sep)[0];
    for(const row of provenanceRows(text)){
      const candidates=byName.get(normalize(row.canonicalName))||[];
      for(const canonical of candidates){
        const canonicalHash=sha256(await readFile(canonical));
        if(canonicalHash!==row.expectedHash)continue;
        const key=normalize(row.incomingName);
        if(!references.has(key))references.set(key,[]);
        references.get(key).push({...row,canonical,canonicalHash,group,transcript});
      }
    }
  }
  const inboxFiles=(await walk(paths.inboxRoot)).filter(path=>!['.DS_Store','.gitkeep'].includes(basename(path)));
  const moves=[];
  const pending=[];
  for(const source of inboxFiles.sort((a,b)=>a.localeCompare(b,'sv'))){
    const sourceHash=sha256(await readFile(source));
    const matches=(references.get(normalize(basename(source)))||[]).filter(item=>item.expectedHash===sourceHash);
    if(!matches.length){pending.push({source,sha256:sourceHash});continue}
    const match=matches[0];
    const preferred=resolve(paths.archiveRoot,match.group,basename(source));
    moves.push({source,target:await uniqueTarget(preferred,sourceHash),sha256:sourceHash,canonical:match.canonical,group:match.group,transcript:match.transcript});
  }
  return {paths,moves,pending};
}

export async function skrivArkiveringslogg(completed,archiveRoot){
  if(!completed.length)return;
  const logPath=resolve(archiveRoot,'_ARKIVERINGSLOGG.md');
  const header=await exists(logPath)?'':'# Arkiveringslogg för behandlade inkorgsoriginal\n\n';
  const rows=completed.map(item=>`| ${basename(item.source)} | ${item.group} | \`${item.sha256}\` |`).join('\n');
  await appendFile(logPath,`${header}## ${new Date().toISOString()}\n\n| Ursprungligt filnamn | Dokumentgrupp | SHA-256 |\n|---|---|---|\n${rows}\n\n`,'utf8');
}

export async function genomforArkivering(plan,{writeLog=true}={}){
  const completed=[];
  try{
    for(const item of plan.moves){
      await mkdir(dirname(item.target),{recursive:true});
      await rename(item.source,item.target);
      const after=sha256(await readFile(item.target));
      if(after!==item.sha256)throw new Error(`Hash ändrades vid flytt: ${item.source}`);
      completed.push(item);
    }
    if(writeLog)await skrivArkiveringslogg(completed,plan.paths.archiveRoot);
    return completed;
  }catch(error){
    await aterstallArkivering(completed);
    throw error;
  }
}

export async function aterstallArkivering(completed){
  for(const item of [...completed].reverse()){
    if(await exists(item.target)&&!await exists(item.source))await rename(item.target,item.source);
  }
}

async function main(){
  const mode=process.argv.includes('--execute')?'execute':'plan';
  const projectRoot=process.env.KORPHOLMEN_PROJEKT_ROOT||resolve(dirname(fileURLToPath(import.meta.url)),'../../../../../..');
  const plan=await planeraArkivering({projectRoot});
  const moved=mode==='execute'?await genomforArkivering(plan):[];
  console.log(JSON.stringify({mode,eligible:plan.moves.length,moved:moved.length,pending:plan.pending.length,archive:plan.paths.archiveRoot},null,2));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
