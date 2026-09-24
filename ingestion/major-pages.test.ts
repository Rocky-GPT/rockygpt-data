import assert from 'node:assert/strict';
import test from 'node:test';

import { majorListings, majorPage, parseMajorPage, type MajorListing } from './major-pages';

const MAJORS = 'https://www.ramapo.edu/majors-minors/majors';
const INDEX = `<html><body><div id="content-block">
  <ul id="filters">
    <li rel="major"><span class="ramaroon">M</span> Major</li>
    <li rel="minor"><span class="ramagrey">m</span> Minor</li>
    <li rel="graduate"><span class="ramagray">G</span> Graduate</li>
    <li rel="all-courses"><span class="ramayellow"><i class="fa fa-refresh"></i></span> Reset</li>
  </ul>
  <div class="row" id="row-courses">
    <div class="course major minor undergrad"><div class="course-wrap" data-url="${MAJORS}/computer-science/">
      <h3>Computer Science </h3><h4>Bachelor of Science <br/></h4>
      <div class="keys"><span class="ramaroon">M</span> <span class="ramagrey">m</span></div></div></div>
    <div class="course graduate"><div class="course-wrap" data-url="/majors-minors/majors/accounting-msac/">
      <h3>Accounting (MSAC) </h3><h4>Master of Science <br/>Graduate Certificate</h4>
      <div class="keys"><span class="ramagray">G</span></div></div></div>
  </div>
</div></body></html>`;

const PAGE = `<html><body>
  <div id="left-nav"><h3>Contact</h3><p>Office of Admissions admissions@ramapo.edu</p></div>
  <h1>Computer Science</h1>
  <div id="content-block">
    <div><h2>About the Computer Science Major</h2>
      <p>Technology is woven into society.</p>
      <h4>4+1 BS to MS</h4><p>Email <a href="mailto:sfrees@ramapo.edu">sfrees@ramapo.edu</a> about the <a href="/dmc/">DMC 4+1 program</a>.</p>
      <ul><li>Earn your Master's in one extra year</li><li>30% savings</li></ul></div>
    <div><h2>What You’ll Learn</h2><a href="#">Classes You Can Take</a>
      <p><a href="https://catalog.ramapo.edu/programs/SN-BS-CMPS/">SEE ALL COURSES AND DEGREE REQUIREMENTS &gt;</a></p>
      <script>track()</script></div>
    <div><h2>Related Programs</h2><a href="https://catalog.ramapo.edu/programs/QVO15cfhYt4RxPPqgpll">Computer Science Minor</a></div>
    <div><h2>Contact</h2><p>For questions, email Victor Miller, Convener of Computer Science.</p></div>
  </div>
</body></html>`;

const CODES = new Set(['SN-BS-CMPS', 'SN-MN-CMPS', 'AH-BA-AFST']);
const GROUPS = new Map([['QVO15cfhYt4RxPPqgpll', 'SN-MN-CMPS']]);
const CS: MajorListing = { url: `${MAJORS}/computer-science/`, name: 'Computer Science', degrees: ['Bachelor of Science'], offers: ['Major', 'Minor'] };

test('the index lists every program card with its degrees and what it offers, in the legend\'s words', () => {
  assert.deepEqual(majorListings(INDEX), [
    CS,
    { url: `${MAJORS}/accounting-msac/`, name: 'Accounting (MSAC)', degrees: ['Master of Science', 'Graduate Certificate'], offers: ['Graduate'] },
  ]);
  assert.throws(() => majorListings('<div id="content-block"></div>'), /lists no programs/);
});

test('a page keeps its own content by section, never the sidebar, with each link\'s section', () => {
  const content = parseMajorPage(PAGE, CS.url);
  assert.equal(content.title, 'Computer Science');
  assert.deepEqual(content.sections.map(section => section.heading), [
    'About the Computer Science Major', 'What You’ll Learn', 'Related Programs', 'Contact']);
  assert.equal(content.sections[0].text, [
    'Technology is woven into society.', '4+1 BS to MS',
    'Email sfrees@ramapo.edu about the DMC 4+1 program .',
    '- Earn your Master\'s in one extra year', '- 30% savings'].join('\n'));
  assert.ok(!content.sections.some(section => /admissions@|track\(\)/.test(section.text)));
  assert.equal(content.sections[3].text, 'For questions, email Victor Miller, Convener of Computer Science.');
  assert.deepEqual(content.links.map(link => [link.name, link.url, link.section]), [
    ['sfrees@ramapo.edu', 'mailto:sfrees@ramapo.edu', 'About the Computer Science Major'],
    ['DMC 4+1 program', 'https://www.ramapo.edu/dmc/', 'About the Computer Science Major'],
    ['SEE ALL COURSES AND DEGREE REQUIREMENTS >', 'https://catalog.ramapo.edu/programs/SN-BS-CMPS/', 'What You’ll Learn'],
    ['Computer Science Minor', 'https://catalog.ramapo.edu/programs/QVO15cfhYt4RxPPqgpll', 'Related Programs'],
  ]);
  assert.throws(() => parseMajorPage('<h1>Elsewhere</h1>', CS.url), /No program content/);
});

test('an older page is divided by its h3 headings', () => {
  const content = parseMajorPage(`<h1>Africana Studies</h1><div id="content-block">
    <h3>About Africana Studies</h3><p>An interdisciplinary major.</p>
    <h3>Africana Studies Minor</h3><p>Eighteen credits.</p></div>`, `${MAJORS}/africana-studies/`);
  assert.deepEqual(content.sections, [
    { heading: 'About Africana Studies', text: 'An interdisciplinary major.' },
    { heading: 'Africana Studies Minor', text: 'Eighteen credits.' },
  ]);
});

test('a page\'s own catalog programs come from its catalog links, apart from related programs', () => {
  const page = majorPage(CS, parseMajorPage(PAGE, CS.url), CS.url, CODES, GROUPS);
  assert.deepEqual(page.programCodes, ['SN-BS-CMPS']);
  // The group ID resolves through the captured catalog to the minor, a related program here.
  assert.deepEqual(page.relatedProgramCodes, ['SN-MN-CMPS']);
  assert.deepEqual(page.limitations, []);
  assert.equal(page.finalUrl, null);
  assert.match(page.id, /^[0-9a-f]{32}$/);
});

test('unknown catalog links, a page with no program of its own, and a redirect elsewhere are reported', () => {
  const bare = parseMajorPage(`<h1>Computer Science</h1><div id="content-block"><h2>About</h2>
    <a href="https://catalog.ramapo.edu/programs/unknownGroupId">Program</a></div>`, CS.url);
  const unlinked = majorPage(CS, bare, CS.url, CODES, GROUPS);
  assert.deepEqual(unlinked.programCodes, []);
  assert.match(unlinked.limitations[0], /not in the captured catalog: https:\/\/catalog\.ramapo\.edu\/programs\/unknownGroupId/);
  assert.match(unlinked.limitations[1], /links no catalog program of its own/);
  const moved = majorPage(CS, { ...parseMajorPage(PAGE, CS.url), title: 'Majors & Minors' }, 'https://www.ramapo.edu/majors-minors/', CODES, GROUPS);
  assert.deepEqual(moved.programCodes, []);
  assert.match(moved.limitations.join(' '), /led to https:\/\/www\.ramapo\.edu\/majors-minors\/, titled "Majors & Minors"/);
});
