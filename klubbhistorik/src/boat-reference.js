const array=value=>Array.isArray(value)?value:value?[value]:[];
const clean=value=>String(value??'').trim();
const unique=values=>[...new Set(values.map(clean).filter(Boolean))];

export function boatReferenceData(reference){
  return reference?.snapshot&&typeof reference.snapshot==='object'
    ? {...reference,...reference.snapshot}
    : reference||{};
}

export function boatPrimaryName(reference){
  const boat=boatReferenceData(reference);
  if(clean(boat.namn||boat.name).toLocaleLowerCase('sv')==='namn okänt'){
    return clean(boat.dopnamn)||clean(boat.onskat_namn)||'Namn okänt';
  }
  return clean(boat.namn||boat.name)||clean(boat.dopnamn)||'Namnlös båt';
}

export function boatReferenceFacts(reference){
  const boat=boatReferenceData(reference);
  const names=unique([
    ...array(boat.tidigare_namn),
    ...array(boat.senare_namn),
    boat.namnstatus==='dopnamn'?'grundnamn okänt':'',
  ]);
  return {
    distinction:clean(boat.urskiljning||boat.distinction),
    type:clean(boat.typ||boat.type),
    model:clean(boat.modell||boat.model),
    year:boat.ar??boat.year??null,
    baptismYear:boat.dopar??boat.baptism_year??null,
    period:clean(boat.period),
    owner:clean(boat.agare||boat.owner),
    names,
    sources:unique(array(boat.kallor_text||boat.sources)),
  };
}

export function boatOptionLabel(reference){
  const facts=boatReferenceFacts(reference);
  const when=facts.period||facts.year||facts.baptismYear;
  return unique([
    [boatPrimaryName(reference),facts.distinction].filter(Boolean).join(' — '),
    facts.type,
    facts.model&&facts.model!==facts.type?facts.model:'',
    when,
    facts.owner,
  ]).join(' · ');
}

export function boatReferenceLines(reference){
  const facts=boatReferenceFacts(reference);
  return {
    title:[boatPrimaryName(reference),facts.distinction].filter(Boolean).join(' — '),
    technical:unique([facts.type,facts.model&&facts.model!==facts.type?facts.model:'',facts.period||facts.year||facts.baptismYear]).join(' · '),
    owner:facts.owner,
    names:facts.names.join(' · '),
    sources:facts.sources.join(' · '),
  };
}
