const anchors=(entries)=>Object.fromEntries(entries.flatMap(([member,...boats])=>boats.map(boat=>[boat,member])));

// Båtraderna kopplas här till den medlemsrad som de står bredvid i trycket.
// Kopplingen beskriver enbart källans layout och är aldrig ett ägarpåstående.
export const BOAT_MEMBER_ANCHORS={
  1980:anchors([
    [1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],[18,18],[19,19],[20,20],
    [22,21,22],[24,23],[25,24],[26,25],[27,26],[28,27],[29,28],[31,29,30],[33,31],[34,32],[35,33],[36,34],[37,35],[38,36],[39,37],[45,38],
    [46,39],[48,40],[53,41],[59,42],[68,43],[69,44],[71,45],
  ]),
  1982:anchors([
    [1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[11,11],[12,12],[13,13],[14,14],[15,15],[16,16],[17,17],
    [19,18,19],[21,20],[25,21],[26,22],[29,23],[30,24],[33,25,26],[34,27],[35,28],[36,29],[37,30],[38,31],
    [43,32],[44,33],[45,34],[46,35],[48,36],[50,37],[56,38],[61,39],[62,40],[64,41],[69,42],[71,43],
  ]),
  1986:anchors([
    [1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[10,9],[11,10],[12,11],[13,12],[14,13],[15,14],[16,15],[17,16],[18,17],[19,18],[20,19],[21,20],[22,21],[23,22],[24,23],
    [29,24,25],[30,26],[31,27],[33,28],[34,29],[35,30],[36,31],[37,32],[38,33],[40,34,35],[41,36],[42,37],[43,38],[44,39],[45,40],[46,41],
    [51,42],[52,43],[54,44],[56,45],[58,46],[59,47],[63,48],[64,49],
  ]),
  1987:anchors([
    [1,1],[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[10,8],[11,9],[12,10],[13,11],[15,12],[16,13],[18,14],[19,15],[20,16],[21,17],[22,18],[23,19],[24,20],[25,21],
    [29,22],[30,23],[33,24],[34,25],[35,26],[36,27],[37,28],[38,29],[42,30],[43,31],[44,32],[45,33],[46,34],[47,35],[48,36],
    [53,37],[54,38],[56,39],[58,40],[60,41],[61,42],[63,43],[65,44],[66,45],
  ]),
  1988:anchors([
    [1,1],[4,2],[5,3],[6,4],[7,5],[10,6],[11,7],[13,8],[14,9],[15,10],[16,11],[17,12],[19,13],[20,14],[22,15],[23,16],[24,17],[25,18],[26,19],[27,20],[29,21],[30,22],[36,23],[37,24],
    [40,25],[41,26],[42,27],[43,28],[44,29],[45,30],[49,31],[50,32],[51,33],[52,34,35],[54,36],[55,37],
    [60,38],[61,39],[63,40],[65,41],[68,42],[70,43],[71,44],
  ]),
  1991:anchors([
    [1,1,2],[4,3],[5,4],[6,5,6],[10,7,8],[11,9,10,11],[12,12],[13,13],[14,14],[15,15,16],[16,17],[18,18],[19,19,20],[21,21,22],[22,23],[23,24,25],[24,26],[25,27,28],[26,29,30],[27,31],[28,32],[29,33],[35,34,35],[36,36],
    [39,37],[40,38,39],[41,40,41],[43,42],[44,43,44],[45,45],[49,46,47,48],[50,49],[51,50],[52,51],[53,52,53],[54,54],[55,55],[56,56],
    [61,57],[62,58],[64,59],[66,60],[68,61],[70,62],[72,63],[73,64],
  ]),
  1996:anchors([
    [1,1,2],[4,3],[5,4],[6,5,6],[9,7],[10,8],[11,9],[12,10],[13,11],[14,12],[15,13],[16,14],[17,15],[19,16],[20,17],[21,18],[22,19],[23,20],[24,21],[25,22],[26,23],[27,24],[28,25],[31,26],[33,27],[34,28],[35,29],[38,30],[39,31],[40,32],[41,33],[42,34],[43,35],
    [44,36],[45,37],[48,38,39,40],[49,41],[50,42],[51,43],[52,44],[53,45],[55,46],[56,47],[58,48],[59,49],
    [64,50],[68,51],[71,52],[72,53],[73,54],[84,55],[85,56],[86,57],
    [117,58],[118,59],[119,60],
  ]),
  1998:anchors([
    [1,1,2],[4,3],[5,4],[7,5,6],[8,7],[10,8],[11,9],[12,10],[13,11],[14,12],[15,13,14],[16,15],[17,16],[19,17],[20,18],[21,19],[22,20],[23,21],[24,22],[25,23],[26,24],[27,25],[28,26],[31,27],[33,28],[34,29],[35,30],[38,31],[39,32],[40,33],[41,34],[42,35],[43,36],
    [44,37],[45,38],[48,39,40,41],[49,42],[50,43],[51,44],[52,45],[53,46],[55,47,48],[56,49],[57,50,51],[59,52],[60,53],[67,54],[70,55],[71,56],[72,57,58],
    [109,59],[110,60],
  ]),
};

export const REPEATED_MEMBER_PLACEMENTS={
  1998:{3:[88,89]},
};

export const CORRESPONDING_NOTE='(stryks efter 5 års tystnad, men kan bli upptagna igen vid behov).';

export function personStructure(personName,category){
  if(category==='blank'||!personName)return {entity_kind:'blank',person_components:[]};
  if(personName==='Familjen Wagstaff')return {entity_kind:'group',person_components:[]};
  if(personName==='Ulla och Stig Freyschuss')return {entity_kind:'multiple_people',person_components:[
    {order:1,person_name_raw:'Ulla Freyschuss'},
    {order:2,person_name_raw:'Stig Freyschuss'},
  ]};
  if(personName==='Ditte och Holger Thufvesson')return {entity_kind:'multiple_people',person_components:[
    {order:1,person_name_raw:'Ditte Thufvesson'},
    {order:2,person_name_raw:'Holger Thufvesson'},
  ]};
  return {entity_kind:'person',person_components:[{order:1,person_name_raw:personName}]};
}

export function exactLegacySections(documentId,year,memberRows){
  if(![1991,1996,1998].includes(year))return null;
  const memberRanges=year===1991?[
    ['active','ORDINARIE MEDLEMMAR',1,1,58],
    ['passive','ORDINARIE PASSIVA MEDLEMMAR',2,59,68],
    ['junior','JUNIORMEDLEMMAR',2,69,94],
    ['corresponding','KORRESPONDERANDE MEDLEMMAR',3,95,96],
  ]:year===1996?[
    ['active','Ordinarie medlemmar',1,1,60],
    ['passive','ORDINARIE PASSIVA MEDLEMMAR',2,61,69],
    ['junior','JUNIORMEDLEMMAR',2,70,115],
    ['corresponding','KORRESPONDERANDE MEDLEMMAR',3,116,119],
  ]:[
    ['active','Ordinarie medlemmar',1,1,63],
    ['passive','ORDINARIE PASSIVA MEDLEMMAR',2,64,65],
    ['junior','JUNIORMEDLEMMAR',2,66,107],
    ['corresponding','KORRESPONDERANDE MEDLEMMAR',3,108,111],
  ];
  const boatRanges=year===1991?[
    ['registered','INREG. FARTYG',1,1,36],
    ['registered','INREG. FARTYG – forts.',2,37,56],
    ['registered-passive','INREG. FARTYG – passiva',2,57,61],
    ['registered-junior','INREG. FARTYG – juniorer',2,62,64],
    ['deregistered-or-renamed','AVREGISTRERADE OCH/ELLER NAMNÄNDRADE FARTYG',3,65,71],
  ]:year===1996?[
    ['registered','Inreg.fartyg',1,1,35],
    ['registered','Inreg.fartyg – forts.',2,36,49],
    ['registered-passive','Inreg.fartyg – passiva',2,50,51],
    ['registered-junior','Inreg.fartyg – juniorer',2,52,57],
    ['registered-corresponding','Inreg.fartyg – korresponderande',3,58,60],
    ['deregistered-or-renamed','AVREGISTRERADE OCH/ELLER NAMNÄNDRADE FARTYG',3,61,67],
  ]:[
    ['registered','Inreg.fartyg',1,1,36],
    ['registered','Inreg.fartyg – forts.',2,37,53],
    ['registered-junior','Inreg.fartyg – juniorer',2,54,58],
    ['registered-corresponding','Inreg.fartyg – korresponderande',3,59,60],
    ['deregistered-or-renamed','AVREGISTRERADE OCH/ELLER NAMNÄNDRADE FARTYG',3,61,67],
  ];
  const memberSections=memberRanges.map(([category,label,page,start,end])=>({
    id:`section:${documentId}:${category}`,
    kind:'member',category,label_raw:label,page,start_order:start,end_order:end,
    note_raw:category==='corresponding'?CORRESPONDING_NOTE:'',
  })).filter(section=>memberRows.some(row=>row.category===section.category));
  const boatSections=boatRanges.map(([category,label,page,start,end],index)=>({
    id:`section:${documentId}:boat:${category}:${index+1}`,
    kind:'boat',category,label_raw:label,page,start_order:start,end_order:end,note_raw:'',
  }));
  return [...memberSections,...boatSections];
}

export function buildLayoutRows(document){
  const year=document.release.year;const anchorsByBoat=BOAT_MEMBER_ANCHORS[year]||{};
  const membersById=new Map(document.member_rows.map(row=>[row.id,row]));
  const boatsByMember=new Map();const unanchored=[];
  for(const boat of document.boat_rows){
    const memberOrder=anchorsByBoat[boat.order];
    if(memberOrder){if(!boatsByMember.has(memberOrder))boatsByMember.set(memberOrder,[]);boatsByMember.get(memberOrder).push(boat.id)}
    else if(boat.category!=='blank'){
      if(BOAT_MEMBER_ANCHORS[year]&&boat.category!=='deregistered-or-renamed')throw new Error(`Båtrad ${year}:${boat.order} saknar källankare.`);
      unanchored.push(boat);
    }
  }
  const rows=[];const add=(page,kind,section,memberRowId=null,boatRowIds=[],textRaw='')=>rows.push({
    id:`layout-row:${document.document.id}:${String(rows.length+1).padStart(3,'0')}`,
    order:rows.length+1,page,kind,section,member_row_id:memberRowId,boat_row_ids:boatRowIds,text_raw:textRaw,
  });
  const pages=[...new Set([...document.member_rows.map(row=>row.page||1),...document.boat_rows.map(row=>row.page||1)])].sort((a,b)=>a-b);
  for(const page of pages){
    const pageMembers=document.member_rows.filter(row=>(row.page||1)===page);
    const repeats=(REPEATED_MEMBER_PLACEMENTS[year]?.[page]||[]).map(order=>document.member_rows.find(row=>row.order===order)).filter(Boolean);
    const placements=[...repeats,...pageMembers];
    for(const member of placements){
      for(const section of document.sections.filter(item=>item.kind==='member'&&item.page===page&&item.start_order===member.order)){
        add(page,'heading',section.category,null,[],section.label_raw);
        if(section.note_raw)add(page,'note',section.category,null,[],section.note_raw);
      }
      add(page,'member',member.category,member.id,boatsByMember.get(member.order)||[],'');
    }
    const pageUnanchored=unanchored.filter(row=>(row.page||1)===page);
    if(pageUnanchored.length){
      const section=document.sections.find(item=>item.kind==='boat'&&item.page===page&&item.category==='deregistered-or-renamed');
      add(page,'heading','deregistered-or-renamed',null,[],section?.label_raw||'AVREGISTRERADE OCH/ELLER NAMNÄNDRADE FARTYG');
      for(const boat of pageUnanchored)add(page,'boat','deregistered-or-renamed',null,[boat.id],'');
    }
  }
  for(const row of rows){
    if(row.member_row_id&&!membersById.has(row.member_row_id))throw new Error(`Okänd medlemsrad i layout: ${row.member_row_id}`);
  }
  return rows;
}
