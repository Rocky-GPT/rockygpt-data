import assert from 'node:assert/strict';
import test from 'node:test';
import { hoursCoverageErrors } from './hours-coverage';
import { campusHoursPublication } from '../../ingestion/campus-hours';

const source={sourceUrl:'https://example.edu/hours',collectedAt:'2026-09-23T12:00:00Z'};
const now=new Date('2026-09-23T12:00:00Z');
const raw=[{name:'Library',hours:{Monday:'9am-5pm'},...source},{name:'Gym',hours:{Monday:'9am-5pm'},notes:'Fall 2026',...source}];

test('withheld schedules preserve places with explicit unknown hours and complete source coverage',()=>{
  const publication=campusHoursPublication(raw,now);
  assert.equal(publication.publishable.length,2);
  assert.equal(publication.publishable[1].hours.Monday,'Hours unavailable');
  assert.deepEqual(hoursCoverageErrors(raw,publication.publishable,{version:1,omitted:publication.omitted},now),[]);
  assert.match(hoursCoverageErrors(raw,publication.publishable,{version:1,omitted:[]},now).join(),/omissions/);
  assert.match(hoursCoverageErrors(raw,[{...raw[0],hours:{Monday:'Closed'}}],{version:1,omitted:publication.omitted},now).join(),/differ/);
});

test('hardcoded schedules cannot inherit a different page’s collection time',()=>{
  assert.match(hoursCoverageErrors([{name:'Office',hours:{Monday:'9am-5pm'}}],[raw[0]],{version:1,omitted:[]},now).join(),/provenance/);
});
