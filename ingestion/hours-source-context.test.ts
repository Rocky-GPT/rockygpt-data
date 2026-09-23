import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { renderHoursSourceContext } from './hours-source-context';
import { GENERAL_CAMPUS_HOURS_URL, LIBRARY_HOURS_URL } from './campus-hours';
import { chunkDocumentSections } from '../src/data-v2/document-text';

test('source policy and dated FAQ survive chunking without reopening rejected schedules', () => {
  const collectedAt = '2026-09-23T20:33:00Z';
  const text = 'The College is closed means offices are closed; essential staff report. '.repeat(30);
  const markdown = renderHoursSourceContext([{ sourceUrl: GENERAL_CAMPUS_HOURS_URL, collectedAt,
    html: `<nav>Global navigation</nav><div id="content-block"><h3>Normal Office Hours:</h3><p>Summer Mon-Thu 8am-5pm</p>
      <h3>Clarification of Terms</h3><p>${text}</p><h3>Center for Student Involvement (CSI)</h3><p>8am-midnight</p>
      <h4>ROADRUNNER CENTRAL</h4><p>Currently closed; visit CSI for assistance.</p><h3>Bookstore</h3>
      <h4>Summer Store Hours:</h4><p>10am-3pm</p><h4>Normal Store Hours:</h4><p>9am-5pm</p>
      <h4>Bookstore FAQ:</h4><p>Last Day to return Spring textbooks is January 30, 2026.</p>
      <p>Digital credentials: <a href="https://redshelf.com/">RedShelf</a>. Do not throw out the receipt.</p></div><footer>Footer noise</footer>` }]);
  assert.doesNotMatch(markdown, /8am-5pm|8am-midnight|10am-3pm|9am-5pm|Global navigation|Footer noise/);
  assert.match(markdown, /January 30, 2026/);
  assert.match(markdown, /https:\/\/redshelf.com\//);
  assert.match(markdown, /Do not throw out the receipt/);
  const chunks = chunkDocumentSections(markdown).filter(chunk => chunk.canonicalUrl);
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every(chunk => chunk.collectedAt === collectedAt && chunk.canonicalUrl === GENERAL_CAMPUS_HOURS_URL));
  assert.ok(chunks.every(chunk => chunk.content.includes('Capture time does not renew dated guidance')));
  assert.match(chunks.map(chunk => chunk.content).join('\n'), /essential staff report/);
});

test('library conditions and source contact links remain separate from conflicting weekly hours', () => {
  const markdown = renderHoursSourceContext([{ sourceUrl: LIBRARY_HOURS_URL, collectedAt: '2026-09-23T20:33:00Z',
    html: `<div id="left-area"><h1>Library Hours</h1><p>RESEARCH HELP HOURS</p><p>Fall Semester<br>(Aug. 26 - Dec. 15, 2026)</p>
      <p>Mon-Thu: 9:00am-9:00pm</p><p>Please note that front doors lock fifteen minutes before closing.</p></div>
      <div id="sidebar"><div class="et_pb_widget"><h4>Ask a Librarian</h4><a href="tel:201.684.7574">201-684-7574</a>
      <a href="https://libcal.ramapo.edu/appointments">Research Appointments</a><a>Chat Busy</a></div>
      <div class="et_pb_widget"><h4>Research Help Hours</h4><p>Fall Semester 2025</p><p>Mon-Thu: 9:00am-9:00pm</p>
      <p>If we are offline, email refdesk@ramapo.edu.</p></div></div>` }]);
  assert.doesNotMatch(markdown, /9:00am|Fall Semester|Chat Busy/);
  assert.match(markdown, /fifteen minutes/);
  assert.match(markdown, /libcal.ramapo.edu\/appointments/);
  assert.match(markdown, /refdesk@ramapo.edu/);
});

test('current captured hours pages retain all closure definitions and bookstore access instructions', () => {
  const file = 'data/raw/hours-sources.raw.json';
  if (!fs.existsSync(file)) return;
  const markdown = renderHoursSourceContext(JSON.parse(fs.readFileSync(file, 'utf8')).captures);
  for (const phrase of ['Lines of authority', 'Non-essential staff will be remote', 'The College will close early',
    'is currently closed and all functions of Roadrunner Central', 'Follett ACCESS', 'January 30, 2026', '05/12/26',
    'full name, phone number and email address', '201.684.7590', '201-425-0095', 'refdesk@ramapo.edu']) {
    assert.ok(markdown.includes(phrase), phrase);
  }
  assert.doesNotMatch(markdown, /Mon-Thu:|Monday - Friday - 8:00|Summer Store Hours:|Chat Busy/);
  assert.ok(chunkDocumentSections(markdown).filter(chunk => chunk.canonicalUrl)
    .every(chunk => chunk.content.includes('Capture time does not renew dated guidance')));
});
