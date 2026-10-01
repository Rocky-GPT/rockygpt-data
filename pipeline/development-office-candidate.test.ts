import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalCandidate, checkedCaptureTime, observationValueHash, remapRecordPins, verifiedContactObservations } from './development-office-candidate';
import { pageKey, type CapturedPage } from '../src/directory/contact-evidence';

test('development staging refuses remote, source overwrite, production names and connection overrides',()=>{
  const good='postgresql://postgres@127.0.0.1:55434/rockygpt_profiles_dev_source';
  assert.equal(assertLocalCandidate(good,'rockygpt_profiles_dev_candidate').hostname,'127.0.0.1');
  for(const source of [good.replace('127.0.0.1','db.example.edu'),good+'?host=db.example.edu',good.replace('rockygpt_profiles_dev_source','production')]) {
    assert.throws(()=>assertLocalCandidate(source,'rockygpt_profiles_dev_candidate'));
  }
  assert.throws(()=>assertLocalCandidate(good,'rockygpt_profiles_dev_source'));
  assert.throws(()=>assertLocalCandidate(good,'production'));
});

test('field observations bind exact projections and retained scoped HTML without renewing labels',()=>{
  const evidence=[{url:'https://example.edu/contact',section:'Contact',near:'Student Support:',fields:['phone' as const,'email' as const,'office' as const]}];
  const page={url:evidence[0].url,fetchedAt:'2026-10-01T12:00:00Z',sections:[{heading:'Contact',text:'Student Support: Phone (201) 555-0100 or (201) 555-0101; help@example.edu; D-224'}]};
  const pages=new Map([[pageKey(page.url),page]]);
  const hashes=new Map([[pageKey(page.url),'a'.repeat(64)]]);
  const row={name:'A historical label',department:'A historical department',email:'help@example.edu',
    phone:'(201) 555-0100 / (201) 555-0101',phones:[{number:'201-555-0100'},{number:'201-555-0101'}],office:'D-224',offices:['D-224']};
  const observations=verifiedContactObservations(row,row,evidence,pages,hashes,new Date('2026-10-01T13:00:00Z')).fields;
  assert.deepEqual(Object.keys(observations).sort(),['email','offices','phones']);
  assert.deepEqual(observations.phones,{captured_at:'2026-10-01T12:00:00.000Z',
    value_sha256:observationValueHash({phone:row.phone,phones:row.phones}),
    pages:[{url:page.url,section:'Contact',near:'Student Support:',fetched_at:page.fetchedAt,html_sha256:'a'.repeat(64)}]});
  assert.throws(()=>verifiedContactObservations({...row,phones:[...row.phones,{number:'201-555-9999'}]},row,evidence,pages,hashes,new Date('2026-10-01T13:00:00Z')));
  assert.throws(()=>verifiedContactObservations({...row,phones:null},{...row,phones:[]},evidence,pages,hashes,new Date('2026-10-01T13:00:00Z')));
  assert.throws(()=>verifiedContactObservations({...row,offices:null},{...row,offices:[]},evidence,pages,hashes,new Date('2026-10-01T13:00:00Z')));
  assert.throws(()=>verifiedContactObservations(row,row,evidence,pages,new Map(),new Date('2026-10-01T13:00:00Z')));
});

test('number-only evidence never freshens a neighboring number, extension, type or extra room',()=>{
  const evidence=[{url:'https://example.edu/contact',section:'Contact',near:'Student Support:',fields:['phone' as const,'office' as const]}];
  const page={url:evidence[0].url,fetchedAt:'2026-10-01T12:00:00Z',sections:[{heading:'Contact',text:'Student Support: (201) 555-0100; D-224. Other department: (201) 555-0101; D-225.'}]};
  const pages=new Map([[pageKey(page.url),page]]),hashes=new Map([[pageKey(page.url),'a'.repeat(64)]]);
  const original={phone:'(201) 555-0100',phones:[{number:'201-555-0100'}]};
  for (const row of [
    {phone:'(201) 555-0100 / (201) 555-0101',phones:[{number:'201-555-0100'},{number:'201-555-0101'}]},
    {...original,phones:[{number:'201-555-0100',extension:'1234'}]},
    {...original,phones:[{number:'201-555-0100',type:'cell'}]},
    {...original,office:'D-224 / D-225',offices:['D-224','D-225']},
  ]) {
    const result=verifiedContactObservations(row,row,evidence,pages,hashes,new Date('2026-10-01T13:00:00Z'));
    assert.equal(result.withheld.length,1);
    assert.equal(result.fields[result.withheld[0].field],undefined);
  }
});

test('projection hashes have a stable cross-language compact Unicode representation',()=>{
  assert.equal(observationValueHash({b:[{z:'café',a:null}],a:true}),
    '26d3403534d85f197e9c53f14ed7f724dcfd5e4d8bc9847283bed3b07281e39f');
  assert.equal(observationValueHash({phone:null,phones:[]}),observationValueHash({phones:[],phone:null}));
  assert.equal(observationValueHash({phone:null,phones:[{type:'téléphone',number:'+12015550100',extension:null},{number:'+12015550101',type:'fax'}]}),
    'b61b2bba806321050153bbf5a93ed19a1ca0b93ae528c932b178bdb7bb01e537');
});

test('an extension cannot refresh a reconstructed full number while independent room evidence survives',()=>{
  const evidence=[{url:'https://example.edu/contact',section:'Student lounge',fields:['phone' as const,'office' as const]}];
  const page={url:evidence[0].url,fetchedAt:'2026-10-01T12:00:00Z',sections:[{heading:'Student lounge',text:'Location: SC-226. Extension: 7796.'}]};
  const row={phone:'(201) 684-7796',phones:[{number:'201-684-7796'}],office:'SC-226',offices:['SC-226']};
  const checked=verifiedContactObservations(row,row,evidence,new Map([[pageKey(page.url),page]]),
    new Map([[pageKey(page.url),'a'.repeat(64)]]),new Date('2026-10-01T13:00:00Z'));
  assert.equal(checked.fields.phones,undefined);
  assert.ok(checked.fields.offices);
  assert.equal(checked.withheld[0].field,'phones');
});

test('a field cites only its supporting pages and named places stay attached to their entry',()=>{
  const evidence=[{url:'https://example.edu/phone',section:'Directory',near:'Student Support:',fields:['phone' as const]},
    {url:'https://example.edu/place',section:'Directory',near:'Student Support:',fields:['office' as const]}];
  const pages=new Map(evidence.map((e,index)=>[pageKey(e.url),{url:e.url,fetchedAt:`2026-10-01T0${index+1}:00:00Z`,
    sections:[{heading:'Directory',text:index?'Student Support: Location: Student Center, 2nd Floor. Other office: Basement.':'Student Support: (201) 555-0100'}]}]));
  const hashes=new Map(evidence.map(e=>[pageKey(e.url),'a'.repeat(64)]));
  const row={phone:'(201) 555-0100',phones:[{number:'201-555-0100'}],office:'Student Center, 2nd Floor',offices:['Student Center, 2nd Floor']};
  const observed=verifiedContactObservations(row,row,evidence,pages,hashes,new Date('2026-10-01T03:00:00Z')).fields as Record<string,{captured_at:string;pages:{url:string}[]}>;
  assert.deepEqual(observed.phones.pages.map(p=>p.url),['https://example.edu/phone']);
  assert.deepEqual(observed.offices.pages.map(p=>p.url),['https://example.edu/place']);
  assert.equal(observed.offices.captured_at,'2026-10-01T02:00:00.000Z');
  const wrong={...row,office:'Basement',offices:['Basement']};
  const rejected=verifiedContactObservations(wrong,wrong,evidence,pages,hashes,new Date('2026-10-01T03:00:00Z'));
  assert.equal(rejected.fields.offices,undefined);
  assert.equal(rejected.withheld[0].field,'offices');
});

test('record pins remap without changing canonical IDs, ordinary values or input objects',()=>{
  const original={id:'original-row',entities:[{id:'canonical-entity',links:[{source_record_ids:['original-row']}]}],
    relationship:{target_entity_id:'canonical-entity',evidence:[{source_record_id:'original-row'}]},text:'original-row'};
  const mapping=new Map([['original-row','new-row'],['canonical-entity','must-not-change']]);
  const result=remapRecordPins(original,mapping) as typeof original;
  assert.equal(result.entities[0].id,'canonical-entity');
  assert.equal(result.id,'original-row');
  assert.equal(result.text,'original-row');
  assert.deepEqual(result.entities[0].links[0].source_record_ids,['new-row']);
  assert.equal(result.relationship.target_entity_id,'canonical-entity');
  assert.equal(result.relationship.evidence[0].source_record_id,'new-row');
  assert.deepEqual(original.entities[0].links[0].source_record_ids,['original-row']);
});

test('record freshness is the oldest actual cited capture and never applies to unknown evidence',()=>{
  const evidence=[{url:'https://example.edu/one',section:'Contact',fields:['phone' as const]},
    {url:'https://example.edu/two',section:'Contact',fields:['email' as const]}];
  const pages=new Map<string,CapturedPage>(evidence.map((e,index)=>[pageKey(e.url),{url:e.url,sections:[],fetchedAt:`2026-10-01T0${index+1}:00:00Z`}]));
  const now=new Date('2026-10-01T12:00:00Z');
  assert.equal(checkedCaptureTime(evidence,pages,now),'2026-10-01T01:00:00.000Z');
  assert.equal(checkedCaptureTime([],pages,now),null);
  assert.throws(()=>checkedCaptureTime(evidence,new Map(),now));
  assert.throws(()=>checkedCaptureTime(evidence,pages,new Date('2026-10-03T12:00:00Z')));
  assert.throws(()=>checkedCaptureTime(evidence,pages,new Date('2026-10-01T00:00:00Z')));
});
