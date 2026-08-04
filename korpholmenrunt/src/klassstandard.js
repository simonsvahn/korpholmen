export const KLASSSTANDARD_VERSION='2026-08-04';
export const KLASSSTANDARD_METHOD=`klassstandard beslutad av Simon ${KLASSSTANDARD_VERSION}`;

export const KLASSER=Object.freeze([
  {id:'kanadensare',name:'Kanadensare',aliases:['Canadian','Canadian*','kanad','Can']},
  {id:'kajak-1',name:'Kajak 1',aliases:['Kajak 1','K1']},
  {id:'kajak-2',name:'Kajak 2',aliases:['Kajak 2','Kajak 2?','K2']},
  {id:'rodd',name:'Rodd',aliases:['Rodd','rodd*','rodd?','rodd?*','Dagen']},
  {id:'segel',name:'Segel',aliases:['Segel','Segel?','S']},
  {id:'optimist',name:'Optimist',aliases:['Optimist','optimist*']},
  {id:'gummi',name:'Gummi',aliases:['Gummi','Gummijolle']},
  {id:'okand',name:'Okänd',aliases:['','?','rodel']},
  {id:'ornjolle',name:'Örnjolle',aliases:['Örnjolle']},
  {id:'jolle',name:'Jolle',aliases:['Jolle','jolle*']},
  {id:'paddel',name:'Paddel',aliases:['Paddel']},
  {id:'rodd-segel',name:'Rodd + segel',aliases:['Rodd + segel','rodd+segel']},
]);

const normalisera=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g,' ').trim();
const KLASS_PER_ALIAS=new Map(KLASSER.flatMap(klass=>[klass.name,...klass.aliases].map(alias=>[normalisera(alias),klass])));
const KLASS_PER_NAMN=new Map(KLASSER.map(klass=>[normalisera(klass.name),klass]));

export function standardklass(raw){return KLASS_PER_ALIAS.get(normalisera(raw))||null}
export function standardklassFranNamn(name){return KLASS_PER_NAMN.get(normalisera(name))||null}
export function klassnamn(raw){return standardklass(raw)?.name||String(raw||'Okänd').replace(/[?*]/g,'').trim()||'Okänd'}
