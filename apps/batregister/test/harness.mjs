import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MemoryStore,
  createBatch,
  createClock,
  createRestoreOperation,
  createSetOperation,
  materialize,
  validateOperation,
} from '../../../packages/core/data-layer.js';
import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_TYPE,
  buildFamilyContext,
  familyBrowseHierarchy,
  familySelectionMatches,
  searchFamilyTargets,
  targetMemberDetails,
} from '../../../packages/core/family-context.js';
import {
  boatMatchesConnection,
  personScopeTargets,
  searchPeopleForConnection,
} from '../src/connection-filter.js';
import {
  boatDisplayHeading,
  boatDisplayName,
  boatQualityFlags,
  conflictingSpecFields,
  currentPilotRecords,
  effectiveSpecValues,
  formatOwnershipPeriod,
  ownerPartyParts,
  ownerPartyText,
  pilotContainsBoat,
  pilotDisplayLabel,
  resolvePilotRecord,
  specRows,
  visibleOwnershipRecords,
} from '../src/boat-master-view.js';
import {
  filterOwnerReviewRows,
  ownerReviewClassLabel,
  unresolvedOwnerReviewRows,
} from '../src/owner-review.js';
import {
  OWNER_ROLES,
  buildOwnerChangeQueue,
  emptyOwnerReviewDocument,
  saveOwnerReviewBatch,
  saveOwnerReviewDecision,
  sourceSupportsOwnership,
  validateOwnerChangeQueue,
  validateOwnerReviewDecision,
} from '../src/owner-review-decisions.js';
import {
  mergedSourceRecords,
  normalizeSourceViewManifest,
  sourceIdsForBoatInManifest,
  sourceViewEntry,
} from '../src/source-review.js';
import {
  buildSpecChangeQueue,
  emptySpecReviewDocument,
  saveSpecReviewDecision,
} from '../src/spec-review-decisions.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const REPO=resolve(ROOT,'../..');
const PRIVATE=resolve(ROOT,'privat/migrering-2026-08-01');
const CORRECTIONS=resolve(ROOT,'privat/korrigeringar');
const PETER_CORRECTION=resolve(CORRECTIONS,'2026-08-03-peter-identitetsdelning.json');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const sha256=value=>createHash('sha256').update(value).digest('hex');
let passed=0;
async function test(name,action){try{await action();passed+=1;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}`);throw error}}

await test('båtmastervyn skiljer namnkollisioner utan att hitta på I och II',()=>{
  assert.equal(boatDisplayHeading({namn:'Snusmumriken',visningsurskiljning:'segelbåt · Inger Bethge'}),'Snusmumriken · segelbåt · Inger Bethge');
  assert.equal(boatDisplayHeading({namn:'Snusmumriken',visningsurskiljning:'kajak · Lotta Svahn'}),'Snusmumriken · kajak · Lotta Svahn');
  assert.equal(boatDisplayName({namn:null,visningsnamn:'Lottas kajak (2026; namn okänt)'}),'Lottas kajak (2026; namn okänt)');
});

await test('båtmastervyn visar bara specifikationer som faktiskt finns',()=>{
  const rows=specRows([{values:{category:'kiteboard',length_ft:18,freeboard_m:0.75,weight_kg:3,volume_l:160,load_capacity_kg:100,engine_brand:'Evinrude',horsepower:null,engine_power_kw:73,horsepower_text:'100/115 hkr'}}]);
  assert.deepEqual(rows.map(row=>[row.label,row.value]),[
    ['Kategori','Kitesurfbräda'],['Längd','18 fot'],['Fribord','0.75 m'],['Vikt','3 kg'],['Volym','160 L'],['Lastkapacitet','100 kg'],['Motorfabrikat','Evinrude'],['Motorstyrka','73 kW'],['Motorstyrka','100/115 hkr'],
  ]);
  assert.equal(formatOwnershipPeriod({start:{year:2026,precision:'year'}}),'från 2026');
  assert.equal(formatOwnershipPeriod({start:{year:1976,precision:'not_later_than'}}),'belagd senast 1976');
  assert.equal(formatOwnershipPeriod({start:{year:1966,precision:'year'},end:{year:1977,precision:'year'}}),'1966–1977');
});

await test('läsprofilen markerar måttkonflikt diskret och döljer dubblerad delägare',()=>{
  assert.deepEqual(conflictingSpecFields([{values:{width_m:1.65}},{values:{width_m:1.7,length_m:4.4}}]),['width_m']);
  const family={party_type:'family-unit',start:{year:1955,precision:'not_later_than'},end:{year:1956,precision:'year'},source_ids:['a','b','c']};
  const person={party_type:'person',start:{year:1955,precision:'not_later_than'},end:{year:1956,precision:'year'},source_ids:['b','c']};
  assert.deepEqual(visibleOwnershipRecords([family,person]),[family]);
});

await test('en godkänd specifikationsrättelse ersätter visningen men bevarar källobservationen',()=>{
  const observations=[
    {id:'spec:borelia:register',values:{engine_brand:'Johnson',horsepower:70},source_ids:['register']},
    {id:'spec:borelia:rattelse',values:{horsepower:90},status:'accepted',accepted_at:'2026-08-06T12:00:00Z',resolves_fields:['horsepower'],source_ids:['simon']},
  ];
  assert.deepEqual(effectiveSpecValues(observations),{horsepower:90,engine_brand:'Johnson'});
  assert.deepEqual(specRows(observations).map(row=>[row.label,row.value]),[['Motorstyrka','90 hk'],['Motorfabrikat','Johnson']]);
  assert.deepEqual(conflictingSpecFields(observations),[]);
});

await test('specifikationsutkast blir en låst ändringskö först när beslutet är klart',()=>{
  const expected=[{entity_id:'spec:borelia:register',record:{boat_id:'borelia',values:{horsepower:70}}}];
  const ready=saveSpecReviewDecision(emptySpecReviewDocument('pilot-test'),{
    decision_id:'spec-review:borelia',boat_id:'borelia',status:'ready',expected_specs:expected,
    values:{horsepower:90},resolves_fields:['horsepower'],field_actions:{horsepower:{action:'correct-source',target_entity_id:'spec:borelia:register'}},note:'Felläsning rättad',updated_at:'2026-08-06T12:00:00Z',
  });
  const queue=buildSpecChangeQueue({document:ready,boats:[{id:'borelia',namn:'Borelia'}],specRecords:[{id:'spec:borelia:register',boat_id:'borelia',values:{horsepower:70}}],exportedAt:'2026-08-06T12:01:00Z'});
  assert.equal(queue.decisions.length,1);
  assert.equal(queue.decisions[0].values.horsepower,90);
  assert.deepEqual(queue.decisions[0].field_actions.horsepower,{action:'correct-source',target_entity_id:'spec:borelia:register'});
});

await test('datakvalitetsfiltren skiljer belagda fakta, luckor och ägarbyten',()=>{
  const flags=boatQualityFlags({
    boat:{agare:'Äldre fritext',images:[{full:{}},{full:{}}]},
    ownershipObservations:[
      {party_type:'person',party_id:'anna',source_ids:['a']},
      {party_type:'person',party_id:'bo',source_ids:['b']},
    ],
    specObservations:[
      {values:{horsepower:6,engine_brand:'Evinrude',length_m:4.4},source_ids:['a']},
      {values:{length_m:4.5},source_ids:['b']},
    ],
    eventObservations:[{event_type:'owner_change_recorded',source_ids:['b']}],
    reviewItems:[{status:'open'}],
  });
  assert.deepEqual([...flags].sort(),[
    'conflict','dimensions','engine-brand','history','horsepower','multiple-images','multiple-sources','open-review','ownership-change','structured-owner',
  ]);
  assert.deepEqual([...boatQualityFlags({boat:{agare:'Namn i äldre register'}})].sort(),['legacy-only','unstructured-owner']);
  assert.deepEqual([...boatQualityFlags({boat:{}})],['legacy-only']);
});

await test('ägarnamn hämtas från person- och familjemastern i stället för lagrad etikett',()=>{
  const context={
    people:[{id:'anna',display_name:'Anna Holm'},{id:'peter',display_name:'Peter Holm'}],
    familyUnits:[{id:'familj-holm',name:'Familjen Holm'}],
    kinGroups:[],
  };
  assert.equal(ownerPartyText({party_type:'person',party_id:'anna',party_label:'Anna Neretnieks'},context),'Anna Holm');
  assert.equal(ownerPartyText({party_type:'family-unit',party_id:'familj-holm',party_label:'Holm'},context),'Familjen Holm');
  assert.equal(ownerPartyText({party_type:'person-set',party_ids:['anna','peter'],party_label:'Anna och Peter'},context),'Anna Holm och Peter Holm');
  assert.deepEqual(ownerPartyParts({party_type:'external-person',party_label:'Roger (efternamn okänt)'},context),[
    {type:'external-person',id:null,label:'Roger (efternamn okänt)'},
  ]);
});

await test('ägargranskningen visar bara olösta fritextposter och kan filtreras utan att godkänna dem',()=>{
  const inventory={rows:[
    {boat_id:'a',boat_name:'Aeola',owner_text:'Johan',classification:'maskinmatchad_identitet_källkontroll_krävs',person_links:[{person_id:'johan',stored_name:'Johan Hedström'}],source_labels:['Registerblad']},
    {boat_id:'b',boat_name:'Båten',owner_text:'Anna och Bo',classification:'flera_personer_att_granska',person_links:[{person_id:'anna',stored_name:'Anna'},{person_id:'bo',stored_name:'Bo'}]},
    {boat_id:'c',boat_name:'Borta',owner_text:'Okänd',classification:'saknar_kopplingskandidat'},
  ]};
  const unresolved=unresolvedOwnerReviewRows({inventory,boats:[{id:'a'},{id:'b'}],ownershipRecords:[{boat_id:'a'}]});
  assert.deepEqual(unresolved.map(row=>row.boat_id),['b']);
  assert.deepEqual(filterOwnerReviewRows(inventory.rows,{search:'hedstrom'}).map(row=>row.boat_id),['a']);
  assert.deepEqual(filterOwnerReviewRows(inventory.rows,{classification:'flera_personer_att_granska'}).map(row=>row.boat_id),['b']);
  assert.equal(ownerReviewClassLabel('flera_personer_att_granska'),'Flera personer');
});

await test('granskningsbeslut håller strukturerad ägarroll separat från mastern och exporterar bara klara poster',()=>{
  const pilotId='batmaster-pilot-test';
  const proposal={
    proposal_id:'owner-proposal:lilla-parlan:1',role:'owner',party_type:'person-set',
    party_ids:['mats','jenny','li','helge'],party_label:'Mats, Jenny, Li och Helge',
    start:{year:2005,precision:'observed'},end:null,sequence:1,status:'accepted',source_ids:['source:application'],
  };
  const decision={decision_id:'owner-review:lilla-parlan',boat_id:'lilla-parlan',mode:'insert',expected_ownerships:[],status:'ready',source_owner_text:'Mats, Jenny, Li och Helge',note:'',ownerships:[proposal],updated_at:'2026-08-06T00:00:00.000Z'};
  assert.equal(OWNER_ROLES.owner,'Ägare');
  assert.equal(sourceSupportsOwnership({authority_for:['owner as written on register leaf']}),true);
  assert.equal(sourceSupportsOwnership({authority_for:['image of vessel or source document']}),false);
  validateOwnerReviewDecision(decision,{requireReady:true});
  const document=saveOwnerReviewDecision(emptyOwnerReviewDocument(pilotId),decision);
  const queue=buildOwnerChangeQueue({document,inventory:{rows:[{boat_id:'lilla-parlan',boat_name:'Lilla Pärlan',owner_text:decision.source_owner_text}]},boats:[{id:'lilla-parlan'}],ownershipRecords:[],sources:[{id:'source:application',label:'Ansökan',kind:'registration-application',entity_ids:['lilla-parlan'],authority_for:['owner statement']}],exportedAt:'2026-08-06T00:00:00.000Z'});
  validateOwnerChangeQueue(queue);
  assert.equal(queue.decisions.length,1);
  assert.equal(queue.decisions[0].ownerships[0].role,'owner');
  assert.deepEqual(queue.decisions[0].ownerships[0].party_ids,['mats','jenny','li','helge']);
  assert.deepEqual(queue.sources.map(source=>source.id),['source:application']);
  assert.throws(()=>validateOwnerReviewDecision({...decision,ownerships:[{...proposal,role:'user'}]},{requireReady:true}),/okänd strukturerad roll/);
  assert.throws(()=>validateOwnerReviewDecision({...decision,ownerships:[{...proposal,source_ids:[]}]},{requireReady:true}),/minst en strukturerad källa/);
  assert.throws(()=>buildOwnerChangeQueue({document,inventory:{rows:[{boat_id:'lilla-parlan',boat_name:'Lilla Pärlan',owner_text:decision.source_owner_text}]},boats:[{id:'lilla-parlan'}],ownershipRecords:[],sources:[{id:'source:application',authority_for:['image of vessel']}]}),/uttryckligen belägger ägande/);
  assert.throws(()=>buildOwnerChangeQueue({document,inventory:{rows:[{boat_id:'lilla-parlan',boat_name:'Lilla Pärlan',owner_text:decision.source_owner_text}]},boats:[{id:'lilla-parlan'}],ownershipRecords:[{id:'owner:lilla-parlan',boat_id:'lilla-parlan'}]}),/måste rättas i korrigeringsläge/);
});

await test('ändringskön blir en reproducerbar pilotplan med länkad personmaster och rollen owner',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'batregister-agarkoe-'));
  try{
    const boatOps=join(scratch,'batregister-ops');
    const matrikelOps=join(scratch,'matrikel-ops');
    await mkdir(boatOps,{recursive:true});
    await mkdir(matrikelOps,{recursive:true});
    const batchFor=(deviceId,entities)=>{
      const clock=createClock(deviceId,()=>1_786_000_000_000);
      const operations=[];
      let seq=0;
      for(const entity of entities){
        operations.push(createRestoreOperation({deviceId,seq:++seq,entityType:entity.type,entityId:entity.id,hlc:clock.tick()}));
        for(const [field,value] of Object.entries(entity.fields))operations.push(createSetOperation({deviceId,seq:++seq,entityType:entity.type,entityId:entity.id,field,value,hlc:clock.tick()}));
      }
      return createBatch(operations);
    };
    const pilotId='batmaster-pilot-testqueue';
    const boatBatch=batchFor('test-boat-master',[
      {type:'boat',id:'testbaten',fields:{namn:'Testbåten',agare:'Anna Test'}},
      {type:'boat-source',id:'source:test',fields:{record:{id:'source:test',label:'Testkälla',kind:'register-leaf',entity_ids:['testbaten'],authority_for:['owner']}}},
      {type:'boat-pilot-manifest',id:pilotId,fields:{record:{pilot_id:pilotId,boat_ids:['testbaten']}}},
    ]);
    const matrikelBatch=batchFor('test-matrikel-master',[
      {type:'person',id:'anna-test',fields:{display_name:'Anna Test'}},
    ]);
    await writeFile(join(boatOps,'batch.json'),`${JSON.stringify(boatBatch)}\n`);
    await writeFile(join(matrikelOps,'batch.json'),`${JSON.stringify(matrikelBatch)}\n`);
    const queue={change_queue_version:3,source_document_version:1,pilot_id:pilotId,exported_at:'2026-08-06T00:00:00.000Z',sources:[{id:'source:test',label:'Testkälla',kind:'register-leaf',entity_ids:['testbaten'],authority_for:['owner']}],decisions:[{
      decision_id:'owner-review:testbaten',boat_id:'testbaten',boat_name:'Testbåten',source_owner_text:'Anna Test',mode:'insert',expected_ownerships:[],note:null,
      ownerships:[{proposal_id:'owner-proposal:testbaten:1',role:'owner',party_type:'person',party_id:'anna-test',party_label:'Anna Test',start:{year:1998,precision:'observed'},end:null,sequence:1,status:'accepted',source_ids:['source:test']}],
    }]};
    const queuePath=join(scratch,'queue.json');
    const planPath=join(scratch,'plan.json');
    await writeFile(queuePath,`${JSON.stringify(queue)}\n`);
    const build=spawnSync(process.execPath,['verktyg/bygg-agarkoplan.mjs',queuePath,boatOps,matrikelOps,planPath],{cwd:ROOT,encoding:'utf8'});
    assert.equal(build.status,0,build.stderr||build.stdout);
    const plan=await readJson(planPath);
    assert.equal(plan.records.length,1);
    assert.equal(plan.records[0].record.role,'owner');
    assert.equal(plan.records[0].record.party_id,'anna-test');
    assert.equal(plan.records[0].record.legacy_owner_text,'Anna Test');
    assert.deepEqual(plan.linked_master_requirements,[{master:'matrikel',entity_type:'person',entity_id:'anna-test',expect:{display_name:'Anna Test'}}]);
    const repeat=spawnSync(process.execPath,['verktyg/bygg-agarkoplan.mjs',queuePath,boatOps,matrikelOps,planPath],{cwd:ROOT,encoding:'utf8'});
    assert.equal(repeat.status,0,repeat.stderr||repeat.stdout);
  }finally{
    await rm(scratch,{recursive:true,force:true});
  }
});

await test('källvisningen håller originalfiler och föreslagna källposter separata från mastern',()=>{
  const manifest=normalizeSourceViewManifest({source_view_manifest_version:1,pilot_id:'pilot-kallor',sources:[
    {local_status:'proposed',source:{id:'source:register-a',label:'Registerblad A',kind:'register-leaf',entity_ids:['a']},artifacts:[{role:'original',web_path:'kallor/a.pdf'}]},
  ],boat_source_ids:{a:['source:register-a']}},'pilot-kallor');
  assert.deepEqual(sourceIdsForBoatInManifest(manifest,'a'),['source:register-a']);
  assert.equal(sourceViewEntry(manifest,'source:register-a').artifacts[0].role,'original');
  assert.deepEqual(mergedSourceRecords([{id:'source:master',label:'Master'}],manifest).map(source=>source.id),['source:master','source:register-a']);
});

await test('batchläget skapar separata ägarbeslut per båt med gemensamt batch-id',()=>{
  const document=saveOwnerReviewBatch(emptyOwnerReviewDocument('pilot-batch'),{
    rows:[{boat_id:'a',boat_name:'A',owner_text:'Anna?'},{boat_id:'b',boat_name:'B',owner_text:'Anna'}],
    party:{party_type:'person',party_id:'anna',party_label:'Anna Test'},
    start:{year:1980,precision:'observed'},end:null,note:'Gemensam kontroll',
    sourceIdsByBoat:{a:['source:a'],b:['source:b']},proposalIdsByBoat:{a:'proposal:a',b:'proposal:b'},
    batchId:'owner-batch:test',updatedAt:'2026-08-06T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(document.decisions).sort(),['a','b']);
  assert.equal(document.decisions.a.batch_id,'owner-batch:test');
  assert.equal(document.decisions.b.batch_id,'owner-batch:test');
  assert.deepEqual(document.decisions.a.ownerships[0].source_ids,['source:a']);
  assert.deepEqual(document.decisions.b.ownerships[0].source_ids,['source:b']);
  assert.notEqual(document.decisions.a.ownerships[0].proposal_id,document.decisions.b.ownerships[0].proposal_id);
});

await test('spara utkast tar automatiskt med vald person eller familj från formuläret',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(app.includes('const pendingTargets = [...ownerReviewComposerTargets]'));
  assert.ok(app.includes('draft.ownerships.push(reviewProposalFromComposer(selectedBoatId, pendingTargets))'));
  assert.ok(app.includes('Välj personen, familjen eller släkten ur söklistan innan du sparar'));
  assert.ok(app.includes('Lägg till nästa ägare'));
  assert.ok(app.includes('Lägg till som samägare'));
});

await test('en rättning låser före-bilden och exporterar en ordnad ägarföljd',()=>{
  const pilotId='pilot-correction';
  const existing={id:'owner:bat:old',boat_id:'bat',role:'owner',party_type:'person-set',party_ids:['anna','bo'],party_label:'Anna och Bo',start:null,end:null,status:'accepted',source_ids:['source:register']};
  const expected=[{entity_id:existing.id,record:Object.fromEntries(Object.entries(existing).filter(([key])=>key!=='id'))}];
  const decision={
    decision_id:'owner-review:bat',boat_id:'bat',mode:'replace',expected_ownerships:expected,status:'ready',source_owner_text:'Anna och Bo',note:'',updated_at:'2026-08-06T00:00:00.000Z',
    ownerships:[
      {proposal_id:'proposal:anna',role:'owner',party_type:'person',party_id:'anna',party_label:'Anna',start:null,end:null,sequence:1,status:'accepted',source_ids:['source:register']},
      {proposal_id:'proposal:bo',role:'owner',party_type:'person',party_id:'bo',party_label:'Bo',start:null,end:null,sequence:2,status:'accepted',source_ids:['source:register']},
    ],
  };
  const document=saveOwnerReviewDecision(emptyOwnerReviewDocument(pilotId),decision);
  const queue=buildOwnerChangeQueue({
    document,
    inventory:{rows:[],structured_review_rows:[{boat_id:'bat',boat_name:'Båten',owner_text:'Anna och Bo'}]},
    boats:[{id:'bat'}],ownershipRecords:[existing],
    sources:[{id:'source:register',label:'Register',kind:'register-leaf',entity_ids:['bat'],authority_for:['owner']}],
    exportedAt:'2026-08-06T00:00:00.000Z',
  });
  validateOwnerChangeQueue(queue);
  assert.equal(queue.decisions[0].mode,'replace');
  assert.deepEqual(queue.decisions[0].ownerships.map(owner=>owner.sequence),[1,2]);
  assert.throws(()=>buildOwnerChangeQueue({document,inventory:{rows:[],structured_review_rows:[{boat_id:'bat',boat_name:'Båten',owner_text:'Anna och Bo'}]},boats:[{id:'bat'}],ownershipRecords:[{...existing,party_label:'Ändrat'}],sources:[{id:'source:register',label:'Register',kind:'register-leaf',entity_ids:['bat'],authority_for:['owner']}]}),/har ändrats/);
});

await test('planbyggaren ersätter en låst ägarpost med append-only tombstone och nya poster',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'batregister-agarrattning-'));
  try{
    const boatOps=join(scratch,'batregister-ops');
    const matrikelOps=join(scratch,'matrikel-ops');
    await mkdir(boatOps,{recursive:true});
    await mkdir(matrikelOps,{recursive:true});
    const batchFor=(deviceId,entities)=>{
      const clock=createClock(deviceId,()=>1_786_000_100_000);
      const operations=[];
      let seq=0;
      for(const entity of entities){
        operations.push(createRestoreOperation({deviceId,seq:++seq,entityType:entity.type,entityId:entity.id,hlc:clock.tick()}));
        for(const [field,value] of Object.entries(entity.fields))operations.push(createSetOperation({deviceId,seq:++seq,entityType:entity.type,entityId:entity.id,field,value,hlc:clock.tick()}));
      }
      return createBatch(operations);
    };
    const pilotId='batmaster-pilot-correction-plan';
    const oldRecord={boat_id:'testbat',role:'owner',party_type:'person-set',party_ids:['anna','bo'],party_label:'Anna och Bo',start:null,end:null,status:'accepted',source_ids:['source:test']};
    await writeFile(join(boatOps,'batch.json'),`${JSON.stringify(batchFor('correction-boat-master',[
      {type:'boat',id:'testbat',fields:{namn:'Testbåten',agare:'Anna och Bo'}},
      {type:'boat-source',id:'source:test',fields:{record:{id:'source:test',label:'Testkälla',kind:'register-leaf',entity_ids:['testbat'],authority_for:['owner']} }},
      {type:'boat-ownership-observation',id:'owner:testbat:old',fields:{record:oldRecord}},
      {type:'boat-pilot-manifest',id:pilotId,fields:{record:{pilot_id:pilotId,boat_ids:['testbat']}}},
    ]))}\n`);
    await writeFile(join(matrikelOps,'batch.json'),`${JSON.stringify(batchFor('correction-matrikel-master',[
      {type:'person',id:'anna',fields:{display_name:'Anna'}},{type:'person',id:'bo',fields:{display_name:'Bo'}},
    ]))}\n`);
    const queue={change_queue_version:3,source_document_version:1,pilot_id:pilotId,exported_at:'2026-08-06T00:00:00.000Z',sources:[{id:'source:test',label:'Testkälla',kind:'register-leaf',entity_ids:['testbat'],authority_for:['owner']}],decisions:[{
      decision_id:'owner-review:testbat',boat_id:'testbat',boat_name:'Testbåten',source_owner_text:'Anna och Bo',mode:'replace',expected_ownerships:[{entity_id:'owner:testbat:old',record:oldRecord}],note:null,
      ownerships:[
        {proposal_id:'proposal:testbat:anna',role:'owner',party_type:'person',party_id:'anna',party_label:'Anna',start:null,end:null,sequence:1,status:'accepted',source_ids:['source:test']},
        {proposal_id:'proposal:testbat:bo',role:'owner',party_type:'person',party_id:'bo',party_label:'Bo',start:null,end:null,sequence:2,status:'accepted',source_ids:['source:test']},
      ],
    }]};
    const queuePath=join(scratch,'queue.json');
    const planPath=join(scratch,'plan.json');
    await writeFile(queuePath,`${JSON.stringify(queue)}\n`);
    const build=spawnSync(process.execPath,['verktyg/bygg-agarkoplan.mjs',queuePath,boatOps,matrikelOps,planPath],{cwd:ROOT,encoding:'utf8'});
    assert.equal(build.status,0,build.stderr||build.stdout);
    const plan=await readJson(planPath);
    assert.deepEqual(plan.changes,[{entity_type:'boat-ownership-observation',entity_id:'owner:testbat:old',expect:{record:oldRecord},delete:true}]);
    assert.deepEqual(plan.records.map(record=>record.record.sequence),[1,2]);
    assert.equal(plan.verify.filter(item=>item.deleted===true).length,1);
  }finally{
    await rm(scratch,{recursive:true,force:true});
  }
});

await test('piloturvalet har begriplig etikett och stabil ID-filtrering',()=>{
  const pilot={scope:'Bethge/Svahn: samtliga källbelagda båtar',boat_ids:['snusmumriken','mymlan']};
  assert.equal(pilotDisplayLabel(pilot),'Bethge/Svahn · 2 båtar');
  assert.equal(pilotContainsBoat(pilot,'mymlan'),true);
  assert.equal(pilotContainsBoat(pilot,'homsan'),false);
});

await test('ett reviderat piloturval ersätter det gamla utan att revisionskvittot skrivs över',()=>{
  const first={pilot_id:'pilot-1',scope:'Bethge/Svahn',boat_ids:['a']};
  const second={pilot_id:'pilot-2',supersedes:'pilot-1',scope:'Bethge/Svahn',boat_ids:['a','sniff']};
  assert.deepEqual(currentPilotRecords([first,second]).map(item=>item.pilot_id),['pilot-2']);
  assert.equal(resolvePilotRecord([first,second],'pilot-1').pilot_id,'pilot-2');
});

const document=await readJson(resolve(PRIVATE,'initial-ops.json'));
const imageManifest=await readJson(resolve(PRIVATE,'bildmanifest.json'));
const decisions=await readJson(resolve(ROOT,'privat/kallkopior/byggkit/godkanda-kopplingar-2026-08-01.json'));
const firstPeterBuild=spawnSync(process.execPath,['verktyg/bygg-peter-identitetsdelning.mjs'],{cwd:ROOT,encoding:'utf8'});
assert.equal(firstPeterBuild.status,0,firstPeterBuild.stderr||firstPeterBuild.stdout);
const firstPeterBytes=await readFile(PETER_CORRECTION);
const secondPeterBuild=spawnSync(process.execPath,['verktyg/bygg-peter-identitetsdelning.mjs'],{cwd:ROOT,encoding:'utf8'});
assert.equal(secondPeterBuild.status,0,secondPeterBuild.stderr||secondPeterBuild.stdout);
const secondPeterBytes=await readFile(PETER_CORRECTION);
const correctionFiles=(await readdir(CORRECTIONS)).filter(file=>file.endsWith('.json')).sort();
const correctionDocuments=await Promise.all(correctionFiles.map(file=>readJson(resolve(CORRECTIONS,file))));
const correctionOperations=correctionDocuments.flatMap(item=>item.operations||item.ops||[]);
const state=materialize([...document.operations,...correctionOperations]);

const matrikelPrivate=resolve(ROOT,'../personer-familjer/privat');
const matrikelMigration=resolve(matrikelPrivate,'migrering-2026-08-01');
const matrikelDocuments=await Promise.all(['initial-ops.json','ui-metadata-ops.json','approved-excel-ops.json'].map(file=>readJson(resolve(matrikelMigration,file))));
const familyBatch=await readJson(resolve(matrikelPrivate,'familjemodell-2026-08-02-batch.json'));
const matrikelPeterCorrectionDirectory=resolve(matrikelPrivate,'korrigeringar/utdata-peter-2026-08-03');
const matrikelPeterCorrectionFiles=(await readdir(matrikelPeterCorrectionDirectory)).filter(file=>file.endsWith('.json')).sort();
const matrikelPeterCorrectionDocuments=await Promise.all(matrikelPeterCorrectionFiles.map(file=>readJson(resolve(matrikelPeterCorrectionDirectory,file))));
const matrikelPeterCorrectionOperations=matrikelPeterCorrectionDocuments.flatMap(item=>item.ops||item.operations||[]);
const matrikelState=materialize([...matrikelDocuments.flatMap(item=>item.operations),...familyBatch.ops,...matrikelPeterCorrectionOperations]);
const entityRows=type=>matrikelState.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
const familyContext=buildFamilyContext({people:entityRows('person'),relations:entityRows('relation'),familyUnits:entityRows('family-unit'),kinGroups:entityRows(KIN_GROUP_TYPE)});

await test('startmastern och rättelserna innehåller 171 båtar och giltiga operationer',()=>{
  assert.equal(sha256(firstPeterBytes),sha256(secondPeterBytes));
  document.operations.forEach(validateOperation);
  correctionOperations.forEach(validateOperation);
  assert.equal(new Set([...document.operations,...correctionOperations].map(operation=>operation.op_id)).size,document.operations.length+correctionOperations.length);
  assert.equal(state.listEntities('boat').length,171);
  assert.equal(state.listEntities('boat-person-link').length,176);
  assert.ok(state.listEntities('family').length>4);
  assert.equal(state.listEntities('boat-family-link').length,9);
  for(const family of decisions.families)assert.ok(state.listEntities('family').some(entity=>entity.entity_id===family.id),family.id);
});

await test('Sommarsol och Neretnieks Majsol hålls isär med källkritiskt registreringsår',()=>{
  const holm=state.getEntity('boat','majsol_holm');
  const neretnieks=state.getEntity('boat','majsol_neretnieks');
  assert.equal(holm.fields.namn,'Majsol');
  assert.deepEqual(holm.fields.tidigare_namn,['Sommarsol']);
  assert.equal(holm.fields.typ,'S/S');
  assert.equal(holm.fields.modell,'Örnjolle');
  assert.equal(holm.fields.dopar,null);
  assert.equal(holm.fields.ar,2013);
  assert.ok(holm.fields.period.includes('registrerad 2013'));
  assert.ok(holm.fields.period.includes('tidpunkter är okända'));
  assert.equal(holm.fields.agare,'Inger Bethge → Anna Holm');
  assert.equal(neretnieks.fields.typ,'S/S');
  assert.equal(neretnieks.fields.ar,null);
  assert.ok(neretnieks.fields.period.includes('1975/77'));
  assert.ok(neretnieks.fields.period.includes('händelsetidpunkt okänd'));
  assert.ok(neretnieks.fields.agarkedja.every(item=>item.ar===null));
  assert.ok(state.getEntity('boat-person-link','majsol_holm--ingerbethge'));
  assert.equal(state.getEntity('boat-person-link','majsol_holm--annaholm').fields.role,'ägare enligt uppgift registrerad 2013 (ägarbytets tidpunkt okänd)');
  assert.ok(state.getEntity('boat-person-link','majsol_neretnieks--ivarsneretnieks'));
  assert.ok(state.getEntity('boat-person-link','majsol_neretnieks--margaretaneretnieks'));
});

await test('de två bekräftade Korpholmen runt-farkosterna är källspårbara utan påstått ägarskap',()=>{
  const aquilo=state.getEntity('boat','aquilogunillo');
  const kareMorfarBengt=state.getEntity('boat','käremorfarbengt');
  assert.equal(aquilo.fields.namn,'Aquilo Gunillo');
  assert.equal(aquilo.fields.period,'belagd i Korpholmen runt 2020');
  assert.equal(aquilo.fields.agare,null);
  assert.equal(kareMorfarBengt.fields.namn,'Käre Morfar Bengt');
  assert.equal(kareMorfarBengt.fields.modell,'Kanadensare (tävlingsklass)');
  assert.equal(kareMorfarBengt.fields.agare,null);
  assert.equal(state.listEntities('boat-person-link').filter(link=>['aquilogunillo','käremorfarbengt'].includes(link.fields.boat_id)).length,0);
});

await test('Junior Peter hålls isär från Peter-Pedal i båtägandet',()=>{
  assert.equal(state.getEntity('boat-person-link','lassemaja--peterholm'),null);
  assert.equal(state.getEntity('boat-person-link','tillfälligheten--peterholm'),null);
  assert.equal(state.getEntity('boat-person-link','lassemaja--peterneretnieks').fields.person_display_name,'Peter Neretnieks');
  assert.equal(state.getEntity('boat-person-link','tillfälligheten--peterneretnieks').fields.person_id,'peterneretnieks');
  assert.equal(state.getEntity('boat-person-link','bossanova--peterholm').fields.person_id,'peterholm');
});

await test('Filifjonkan I och II är två båtar utan att ettans historik går förlorad',()=>{
  const first=state.getEntity('boat','filifjonkaniii');
  const second=state.getEntity('boat','filifjonkanii');
  assert.equal(first.fields.namn,'Filifjonkan I');
  assert.equal(first.fields.modell,'M/S Selko');
  assert.deepEqual(first.fields.tidigare_namn,['Filifjonkan']);
  assert.equal(first.fields.ar,1962);
  assert.equal(first.fields.images.length,1);
  assert.equal(second.fields.namn,'Filifjonkan II');
  assert.equal(second.fields.modell,'M/S Askeladden');
  assert.equal(second.fields.ar,null);
  assert.deepEqual(second.fields.images,[]);
  assert.ok(state.getEntity('boat-person-link','filifjonkaniii--perolofbethge'));
  assert.ok(state.getEntity('boat-family-link','filifjonkanii--family--bethge'));
});

await test('alla säkra båt-person-länkar pekar på en person i Matrikeln',async()=>{
  const people=new Set(matrikelState.listEntities('person').map(person=>person.entity_id));
  for(const link of state.listEntities('boat-person-link'))assert.ok(people.has(link.fields.person_id),link.fields.person_id);
  for(const family of state.listEntities('family'))for(const personId of family.fields.explicit_person_ids||[])assert.ok(people.has(personId),personId);
});

await test('godkända och avvisade kopplingar hålls isär',()=>{
  const links=new Set(state.listEntities('boat-person-link').map(link=>`${link.fields.boat_id}--${link.fields.person_id}`));
  const supersededApprovedLinks=new Set(correctionDocuments.flatMap(document=>(document.supersedes||[]).map(item=>item.entity_id)));
  for(const link of decisions.approved_person_links){
    const key=`${link.boat_id}--${link.person_id}`;
    if(supersededApprovedLinks.has(key))assert.ok(!links.has(key),`Återkallad länk är fortfarande aktiv: ${link.boat_id} → ${link.person_id}`);
    else assert.ok(links.has(key),`Godkänd länk saknas: ${link.boat_id} → ${link.person_id}`);
  }
  for(const link of decisions.rejected_person_suggestions)assert.ok(!links.has(`${link.boat_id}--${link.person_id}`),`Avvisad länk återkom: ${link.boat_id} → ${link.person_id}`);
  assert.ok(links.has('gerry--lisaböving'));
  assert.ok(!links.has('gerry--lisalifilipåkerman'));
  assert.ok(links.has('eos--nissehedströmyngre'));
  assert.ok(links.has('goggelmoggel--nissehedströmyngre'));
  assert.ok(!links.has('eos--nilshenrikhedström'));
  assert.ok(!links.has('goggelmoggel--nilshenrikhedström'));
  const lillaManasse=state.listEntities('boat').find(boat=>boat.entity_id==='lillamanasse');
  assert.equal(lillaManasse.fields.island_connection,'före ön');
});

await test('bildmanifestet är komplett och kryptografiskt låst',async()=>{
  assert.equal(imageManifest.counts.image_records,100);
  assert.equal(imageManifest.image_files.length,193);
  for(const file of imageManifest.image_files){const bytes=await readFile(resolve(PRIVATE,'bilder',file.filename));assert.equal(bytes.length,file.bytes);assert.equal(sha256(bytes),file.sha256)}
});

await test('Dropbox-namnrymden skiljer Båtregister från Matrikeln',async()=>{
  const transport=await readFile(resolve(REPO,'packages/core/sync/dropbox-transport.js'),'utf8');
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(transport.includes("opsRoot = '/ops'"));
  assert.ok(app.includes("opsRoot: '/batregister/ops'"));
  assert.ok(app.includes("opsRoot:'/matrikel/ops'"));
  assert.ok(app.includes("opsRoot:'/matrikel/ops',readOnly:true"));
  assert.ok(app.includes("new ReadOnlyMaster({store,cacheKey:'matrikel'})"));
  assert.ok(app.includes('personNameForLink(link)'));
});

await test('webbgränssnittet kan ändra båtar, länkar och bilder',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const html=await readFile(resolve(ROOT,'index.html'),'utf8');
  assert.ok(app.includes("repository.setField('boat'"));
  assert.ok(app.includes("entityType:'boat-person-link'"));
  assert.ok(app.includes("entityType:'boat-family-link'"));
  assert.ok(app.includes("entityType:'boat-group-link'"));
  assert.ok(app.includes('person:${person.id}'));
  assert.ok(app.includes('id="relation-link-search"'));
  assert.ok(app.includes('FAMILY_UNIT_TYPE'));
  assert.ok(app.includes('KIN_GROUP_TYPE'));
  assert.ok(app.includes('boatMatchesConnectionTarget'));
  assert.ok(app.includes('../personer-familjer/?person='));
  assert.ok(html.includes('id="connection-filter-search"'));
  assert.ok(html.includes('id="connection-filter-browse"'));
  assert.ok(html.includes('id="filter-panel"'));
  assert.ok(html.includes('id="view-panel"'));
  assert.ok(html.includes('id="active-filters"'));
  assert.equal(html.includes('id="person-filter"'),false);
  assert.ok(html.includes('role="combobox"'));
  assert.ok(html.includes('Person, familj eller släkt'));
  assert.equal(html.includes('stabil FAMILJ'),false);
  assert.equal(html.includes('stabil SLÄKT'),false);
  assert.ok(app.includes('uploadBlobWithRetry'));
  assert.ok(app.includes('drawerGalleryMarkup'));
  assert.ok(app.includes("'document-image': 'Dokumentbild'"));
  assert.ok(app.includes("repository.deleteEntities"));
  assert.equal((app.match(/repository\.upsertFields\(/g)||[]).length,4);
});

await test('anknytningsfiltret söker personer och bläddrar bland stabila grupper utan äldre etiketter', async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const html=await readFile(resolve(ROOT,'index.html'),'utf8');
  assert.ok(app.includes('searchFamilyTargets'));
  assert.ok(app.includes('searchPeopleForConnection'));
  assert.ok(app.includes('searchableFamilyTargets'));
  assert.ok(app.includes('renderConnectionBrowseResults'));
  assert.ok(app.includes('renderPersonScopeResults'));
  assert.equal(html.includes('<select id="connection-filter"'),false);
  assert.equal(html.includes('Äldre etiketter'),false);
  assert.equal(app.includes('<optgroup label="Äldre familjeetiketter"'),false);
  const personResults=searchPeopleForConnection(familyContext.people,'Svahn');
  assert.ok(personResults.length>0);
  const results=searchFamilyTargets(familyContext,'Svahn');
  assert.ok(results.length>0);
  assert.ok(results.every(result=>[KIN_GROUP_TYPE,'family-unit'].includes(result.type)));
  const hierarchy=familyBrowseHierarchy(familyContext);
  const visitedGroups=[];
  const visit=group=>{visitedGroups.push(group.id);for(const child of hierarchy.childGroupsByParentId.get(group.id)||[])visit(child)};
  hierarchy.roots.forEach(visit);
  assert.equal(new Set(visitedGroups).size,familyContext.kinGroups.length);
  const placedFamilies=[...hierarchy.familyUnitsByKinGroupId.values()].flat().length+hierarchy.unlinkedFamilyUnits.length;
  assert.equal(placedFamilies,familyContext.familyUnits.length);
});

await test('en vald person erbjuder person, nära familj och tillhörande släktnivåer',()=>{
  const family=familyContext.familyUnits.find(item=>(item.kin_group_ids||[]).length&&targetMemberDetails({type:FAMILY_UNIT_TYPE,id:item.id},familyContext).length);
  assert.ok(family);
  const personId=targetMemberDetails({type:FAMILY_UNIT_TYPE,id:family.id},familyContext)[0].person_id;
  const scopes=personScopeTargets(personId,familyContext);
  assert.ok(scopes.some(target=>target.type==='person'&&target.id===personId));
  assert.ok(scopes.some(target=>target.type===FAMILY_UNIT_TYPE&&target.id===family.id));
  for(const kinGroupId of family.kin_group_ids)assert.ok(scopes.some(target=>target.type===KIN_GROUP_TYPE&&target.id===kinGroupId),kinGroupId);
});

await test('båtar kan länkas till stabil FAMILJ eller SLÄKT med ärvd synlighet',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const filter=await readFile(resolve(ROOT,'src/connection-filter.js'),'utf8');
  const core=await readFile(resolve(REPO,'packages/core/family-context.js'),'utf8');
  assert.ok(filter.includes('familySelectionMatches'));
  assert.ok(app.includes('targetMemberDetails'));
  assert.ok(app.includes("field:'target_code'"));
  assert.ok(app.includes("field:'confirmed',value:true"));
  assert.ok(core.includes('anchors_and_descendants'));
  assert.ok(core.includes("return 'FAMILJ'"));
  assert.ok(core.includes("return 'SLÄKT'"));
});

await test('SLÄKT-filter hittar personlänkar och godkända äldre familjeetiketter',()=>{
  const targetGroup=familyContext.kinGroups.find(group=>group.reference_code==='SLÄKT-006');
  assert.equal(targetGroup.name,'Lena–Böving');
  const target={type:KIN_GROUP_TYPE,id:targetGroup.id};
  const boats=state.listEntities('boat').map(entity=>({id:entity.entity_id,...entity.fields}));
  const personLinks=state.listEntities('boat-person-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  const familyLinks=state.listEntities('boat-family-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  const groupLinks=state.listEntities('boat-group-link').map(entity=>({id:entity.entity_id,...entity.fields}));
  assert.equal(groupLinks.length,0);
  const hits=boats.filter(boat=>familySelectionMatches({
    target,
    context:familyContext,
    structuredAssociations:groupLinks.filter(link=>link.boat_id===boat.id),
    linkedPersonIds:personLinks.filter(link=>link.boat_id===boat.id).map(link=>link.person_id),
    legacyFamilyLabels:[boat.slakt,...familyLinks.filter(link=>link.boat_id===boat.id).map(link=>link.family_name)],
  }));
  assert.equal(hits.length,29);
  assert.ok(hits.some(boat=>boat.namn==='Gerry'));
  assert.ok(hits.some(boat=>boat.namn==='Pancho'));
  const value=`${KIN_GROUP_TYPE}:${targetGroup.id}`;
  const connectionHits=boats.filter(boat=>boatMatchesConnection({
    boat,
    value,
    context:familyContext,
    personLinks:personLinks.filter(link=>link.boat_id===boat.id),
    groupLinks:groupLinks.filter(link=>link.boat_id===boat.id),
    legacyFamilyLabels:[boat.slakt,...familyLinks.filter(link=>link.boat_id===boat.id).map(link=>link.family_name)],
  }));
  assert.deepEqual(connectionHits.map(boat=>boat.id),hits.map(boat=>boat.id));
});

await test('båtbilder kan köas och läsas lokalt utan Dropbox',async()=>{
  const store=new MemoryStore();
  const blob=new Blob(['offline-bild'],{type:'image/jpeg'});
  await store.putBlob('/batregister/bilder/offline.jpg',blob,{pendingUpload:true});
  assert.equal(await (await store.getBlob('/batregister/bilder/offline.jpg')).text(),'offline-bild');
  assert.equal((await store.listPendingBlobs()).length,1);
  await store.markBlobUploaded('/batregister/bilder/offline.jpg');
  assert.equal((await store.listPendingBlobs()).length,0);
});

await test('webbappen lagrar hela bildbeståndet och nya bilder för offlinebruk',async()=>{
  const app=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  const storage=await readFile(resolve(REPO,'packages/core/storage/indexeddb.js'),'utf8');
  assert.ok(storage.includes("createObjectStore('blobs'"));
  assert.ok(app.includes('cacheAllBoatImages'));
  assert.ok(app.includes('uploadPendingImageBlobs'));
  assert.ok(app.includes("store.putBlob(path,prepared.blob,{pendingUpload:true})"));
  assert.ok(app.includes("Offline · lokalt sparat · synkas automatiskt"));
});

await test('publiceringsbygget är datafritt',()=>{
  const result=spawnSync(process.execPath,['verktyg/bygg-publicering.mjs'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

await test('publiceringspaketet har en egen offlinebar kopia av kärnan',async()=>{
  const publishedApp=await readFile(resolve(REPO,'batregister/src/app.js'),'utf8');
  const publishedFilter=await readFile(resolve(REPO,'batregister/src/connection-filter.js'),'utf8');
  const publishedCore=await readFile(resolve(REPO,'batregister/core/data-layer.js'),'utf8');
  const serviceWorker=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedFilter.includes("../core/family-context.js"));
  assert.ok(publishedCore.includes("./storage/indexeddb.js"));
  assert.ok(serviceWorker.includes("?'../../packages/core':'./core'"));
  assert.ok(serviceWorker.includes("'./src/config.js?v=2026-08-06-batmaster-pilot-14'"));
  assert.ok(serviceWorker.includes("'./src/connection-filter.js'"));
  assert.ok(serviceWorker.includes("'./src/owner-review-decisions.js?v=2026-08-06-owner-review-4'"));
});

await test('OAuth-returen kan skickas till båda apparna',async()=>{
  const root=await readFile(resolve(REPO,'index.html'),'utf8');
  const rootApp=await readFile(resolve(REPO,'src/app.js'),'utf8');
  const bootstrap=await readFile(resolve(REPO,'src/app-family-bootstrap.js'),'utf8');
  const matrikel=await readFile(resolve(REPO,'apps/personer-familjer/src/app.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'src/app.js'),'utf8');
  assert.ok(rootApp.includes('korpholmen:oauth-return'));
  assert.ok(bootstrap.includes('mirrorSharedDropboxCredential'));
  assert.ok(root.includes('matrikel/'));
  assert.ok(root.includes('batregister/'));
  assert.ok(matrikel.includes("isSourceTree ? '../../' : '../'"));
  assert.ok(boats.includes("isSourceTree ? '../../' : '../'"));
});

await test('service workers rensar bara sina egna cacher',async()=>{
  const matrikel=await readFile(resolve(REPO,'apps/personer-familjer/sw.js'),'utf8');
  const boats=await readFile(resolve(ROOT,'sw.js'),'utf8');
  assert.ok(matrikel.includes("key.startsWith('korpholmen-matrikel-')"));
  assert.ok(boats.includes("key.startsWith('korpholmen-batregister-')"));
  assert.ok(matrikel.includes("return cached || network"));
  assert.ok(boats.includes("return cached||network"));
});

console.log(`\n${passed} Båtregister-kontrakt godkända.`);
