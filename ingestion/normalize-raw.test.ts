import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRaw } from './normalize-raw';
import { createHash } from 'node:crypto';

const captured='2026-09-23T12:00:00Z';
const eventUrl='https://archway.ramapo.edu/rsvp_boot?id=1';
function fixture() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rocky-normalize-'));
  const raw=path.join(cwd,'data/raw');fs.mkdirSync(raw,{recursive:true});
  const put=(name:string,value:unknown)=>fs.writeFileSync(path.join(raw,`${name}.raw.json`),JSON.stringify(value));
  const dataset=(name:string,pages:unknown[]=[])=>({version:'1.0',dataset:name,collectedAt:captured,seedUrls:[],stats:{pagesFetched:pages.length,pagesFailed:0,externalLinksSeen:0},pages});
  const page={url:eventUrl,sourceType:'detail',fetchedAt:captured,statusCode:200,title:'Meeting',links:[],externalLinks:[],sections:[{heading:'Details',text:'Complimentary lunch is provided for this occurrence.'}],lists:[],tables:[],contacts:[],documents:[]};
  const menu=[{name:'Lunch',groups:[{name:'Station',items:[{formalName:'Soup',portionSize:'8 oz'}]}]}];
  put('menu',menu);put('menu-week',{version:1,collectedAt:captured,dates:[{date:'2026-09-23',sections:menu}]});
  put('dining-hours',{composition:{subject:{regions:[{fragments:[{type:'Location',content:{main:{name:'Cafe',openingHours:{standardHours:[],seasonalHours:[]}}}}]}]}}});
  put('events',[{title:'Meeting',date:'Sep 23, 2026',time:'12:00 PM',url:eventUrl}]);
  put('events-detail',dataset('events-detail',[page]));
  put('events-signals',{version:'1.0',dataset:'events-signals',collectedAt:captured,signals:[{url:eventUrl,description:'Complimentary lunch is provided for this occurrence.'}]});
  put('clubs',[{name:'Club',category:'Student Organization',clubId:'123'}]);put('clubs-detail',dataset('clubs-detail'));
  put('calendar',[{name:'Fall 2026',events:[{title:'Classes begin',date:'August 26, 2026'}]}]);
  put('faculty',[{name:'Professor',title:'Professor',school:'School',profileUrl:'https://example.edu/faculty/professor'}]);
  const html='<div class="callout-no-image"><h1>Professor</h1></div><div id="content-block"><div class="col-lg-12"><h3>Professor</h3><p><strong>Recent Publications</strong></p><ul><li>Complete captured research citation.</li></ul></div></div>';
  put('faculty-sources',{schemaVersion:1,pages:[{requestedUrl:'https://example.edu/faculty/professor',url:'https://example.edu/faculty/professor',role:'profile',school:'School',fetchedAt:captured,status:200,html,contentHash:createHash('sha256').update(html).digest('hex')}]});
  put('hours',[{name:'Library',hours:{Monday:'9am-5pm'},sourceUrl:'https://example.edu/library',collectedAt:captured},{name:'Gym',hours:{Monday:'9am-5pm'},notes:'Fall 2026',sourceUrl:'https://example.edu/gym',collectedAt:captured}]);
  for(const name of ['transportation','directory','housing','health','counseling','safety','major-page-links','office-pages','academic-sites']) {
    put(name,dataset(name));
    put(`${name}-sources`,{schemaVersion:1,dataset:name,generatedAt:captured,collectionSucceeded:true,pages:[]});
  }
  put('catalog-programs-api',{scrapedAt:captured,programs:Array.from({length:50},(_,i)=>({id:String(i),code:`TS-BS-P${i}`,name:`Program ${i}`,status:'Active',college:'Science, Nursing and Health'})),courses:[{code:'COMP101',name:'New captured course',status:'Active'}]});
  return {cwd,put,read:(file:string)=>JSON.parse(fs.readFileSync(path.join(cwd,file),'utf8'))};
}

test('offline normalization replays complete captures and replaces both projections without refreshing provenance',()=>{
  const f=fixture();
  try {
    const sentinel=path.join(f.cwd,'data/raw/events.provenance.json');fs.writeFileSync(sentinel,'{"captured":"original"}');
    normalizeRaw(f.cwd,{now:new Date(captured)});
    assert.equal(f.read('data/normalized/events.json')[0].offersFreeFood,true);
    assert.deepEqual(f.read('data/normalized/faculty.json')[0].publishedResearch,['Complete captured research citation.']);
    assert.match(f.read('data/normalized/events.json')[0].description,/Complimentary lunch/);
    assert.deepEqual(f.read('public/data/events.json'),f.read('data/normalized/events.json'));
    assert.equal(f.read('public/data/clubs.json')[0].clubId,'123');
    assert.equal(f.read('data/normalized/menu-week.json').dates[0].date,'2026-09-23');
    assert.equal(f.read('data/normalized/hours.json').length,2);
    assert.equal(f.read('data/normalized/hours.json')[1].hours.Monday,'Hours unavailable');
    assert.equal(f.read('data/normalized/hours-omissions.json').omitted[0].reason,'unbounded-term');
    assert.equal(f.read('public/data/programs.json').generatedAt,captured);
    assert.equal(f.read('public/data/courses.json')['COMP 101'].name,'New captured course');
    assert.equal(fs.readFileSync(sentinel,'utf8'),'{"captured":"original"}');
    f.put('events',[{title:'Changed source',date:'Sep 23, 2026',url:eventUrl}]);
    normalizeRaw(f.cwd,{now:new Date(captured)});
    assert.equal(f.read('public/data/events.json')[0].title,'Changed source');
  } finally {fs.rmSync(f.cwd,{recursive:true,force:true});}
});

test('invalid late input fails before overwriting any existing normalized output',()=>{
  const f=fixture();
  try {
    normalizeRaw(f.cwd,{now:new Date(captured)});
    const previous=fs.readFileSync(path.join(f.cwd,'data/normalized/menu.json'),'utf8');
    f.put('menu',[{name:'Dinner',groups:[{name:'Station',items:[{formalName:'Changed source'}]}]}]);
    f.put('catalog-programs-api',{});
    assert.throws(()=>normalizeRaw(f.cwd,{now:new Date(captured)}),/dated program and course capture/);
    assert.equal(fs.readFileSync(path.join(f.cwd,'data/normalized/menu.json'),'utf8'),previous);
  } finally {fs.rmSync(f.cwd,{recursive:true,force:true});}
});
