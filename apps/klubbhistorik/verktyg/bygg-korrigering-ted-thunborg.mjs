import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeleteOperation, createSetOperation } from '../../../packages/core/data-layer.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=resolve(ROOT,'privat/korrigeringar/2026-08-03-ted-thunborg-dublett.json');
const DEVICE='correction-klubbhistorik-ted-thunborg-2026-08-03';
const CLOCK_MS=1785787200000;
const DUPLICATE_OCCURRENCE='person-occurrence:matrikel-2025:145';
const KEPT_OCCURRENCE='person-occurrence:matrikel-2025:144';
const SOURCE_ROWS=[
  'source-row:person-occurrence:matrikel-2025:145',
  'source-row:canonical:source-document:matrikel-2025:numbers-export:member:145',
];
const NOTE=`Källdubblett av ${KEPT_OCCURRENCE}; raden bevaras ordagrant men skapar ingen extra normaliserad medlemsförekomst.`;
const sha256=value=>createHash('sha256').update(value).digest('hex');
let seq=0;
const nextHlc=()=>`${CLOCK_MS}-${String(seq).padStart(6,'0')}-${DEVICE}`;
const deleteOccurrence=()=>{seq+=1;return createDeleteOperation({deviceId:DEVICE,seq,entityType:'person-occurrence',entityId:DUPLICATE_OCCURRENCE,hlc:nextHlc()})};
const set=(entityId,field,value)=>{seq+=1;return createSetOperation({deviceId:DEVICE,seq,entityType:'source-row',entityId,field,value,hlc:nextHlc()})};

const operations=[deleteOccurrence()];
for(const sourceRow of SOURCE_ROWS){
  operations.push(set(sourceRow,'occurrence_ids',[]));
  operations.push(set(sourceRow,'normalization_note',NOTE));
}

const document={
  operations_version:1,
  correction_id:'ted-thunborg-dublett-2025',
  device_id:DEVICE,
  reason:'Ted Thunborg står dubbelt i 2025 års Numbers-källa. Källraderna bevaras, men den andra normaliserade förekomsten undertrycks.',
  kept_occurrence_id:KEPT_OCCURRENCE,
  deleted_occurrence_id:DUPLICATE_OCCURRENCE,
  operations_sha256:sha256(Buffer.from(JSON.stringify(operations))),
  operations,
};

await mkdir(dirname(OUT),{recursive:true});
await writeFile(OUT,`${JSON.stringify(document,null,2)}\n`);
console.log(`Ted Thunborg-dubbletten undertryckt med ${operations.length} append-only-operationer.`);
