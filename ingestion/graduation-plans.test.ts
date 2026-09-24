import assert from 'node:assert/strict';
import test from 'node:test';

import { graduationPlan, parseGraduationPlan, planListings, planPrograms, withSiteGrouping } from './graduation-plans';

const PLAN = 'https://www.ramapo.edu/recommended-graduation-plan-2026';
const section = (title: string, body: string) =>
  `<div class="collapsableContent"><div class="collapsableTitle"><span></span>${title}</div><div class="c_content">${body}</div></div>`;
const INDEX = `<html><body><div id="content-block">
  ${section('Fall 2026 Recommended Graduation Plans by Major', `<ul>
    <li><a href="${PLAN}/tas/computer-science/" data-guid="CMPS">Computer Science</a><ul>
      <li><a href="${PLAN}/tas/computer-science-with-ms-in-data-science/" data-guid="CMPS-DS">Computer Science with MS in Data Science 4+1</a></li>
      <li><a href="${PLAN}/tas/computer-science-with-ms-in-computer-science-41/">Computer Science with MS in Computer Science 4+1</a></li>
    </ul></li>
    <li><a href="https://www.ramapo.edu/testing/">Placement testing</a></li>
  </ul>`)}
  ${section('Fall 2023 Recommended Four-Year Plans by Major', `<ul>
    <li><a href="https://www.ramapo.edu/four-year-2023-2024/tas/computer-science-with-ms-in-computer-science-41/">Computer Science with MS in Computer Science 4+1</a></li>
    <li><a href="https://www.ramapo.edu/four-year-2023-2024/nursing-rn-bsn/">Nursing RN to BSN</a></li>
  </ul>`)}
</div></body></html>`;

test('the index lists each cohort\'s plans, with variants under the major they are nested in', () => {
  const listings = planListings(INDEX);
  assert.deepEqual(listings.map(listing => [listing.cohort, listing.name, listing.code, listing.parent?.name ?? null]), [
    ['Fall 2026', 'Computer Science', 'CMPS', null],
    ['Fall 2026', 'Computer Science with MS in Data Science 4+1', 'CMPS-DS', 'Computer Science'],
    ['Fall 2026', 'Computer Science with MS in Computer Science 4+1', null, 'Computer Science'],
    ['Fall 2023', 'Computer Science with MS in Computer Science 4+1', null, null],
    ['Fall 2023', 'Nursing RN to BSN', null, null],
  ]);
  assert.equal(listings[0].listing, 'Fall 2026 Recommended Graduation Plans by Major');
  // A flat listing takes the major the index nests the same plan under elsewhere; others stay flat.
  const grouped = withSiteGrouping(listings);
  assert.equal(grouped[3].parent?.name, 'Computer Science');
  assert.equal(grouped[3].groupedElsewhere, true);
  assert.equal(grouped[4].parent, null);
  assert.throws(() => planListings('<div id="content-block"></div>'), /lists no plans/);
});

const PAGE = `<html><head><title>Computer Science - Recommended Graduation Plan (Fall 2026)</title></head><body>
<h1>Ramapo College</h1><h1>Computer Science</h1>
<div id="content-block">
  <div class="row colSet">
    <div class="sColumn"><p>This recommended graduation plan is a blueprint.</p>
      <p><strong>NOTE:</strong> This recommended Graduation Plan is applicable to students admitted into the major during the 2026-2027 academic year.</p></div>
    <div class="sColumn"><p><a class="btn" href="/uploads/plan.docx.pdf">PDF</a><br><a class="btn" href="/uploads/plan.docx">Create My Plan (.doc)</a></p></div>
  </div>
  <div class="row colSet"><div class="infoBox"><div class="boxTitle">Math Placement</div><div class="boxContent"><p>MATH 021/022 to MATH 024 to MATH 110-121</p></div></div></div>
  <p><b>NOTE</b>: CRWT and MATH courses are determined by placement testing.</p>
  <div class="fouryear">
    <h3>First Year</h3>
    <h4>Fall Semester</h4>
    <ul>
      <li>Major: <a href="https://catalog.ramapo.edu/courses/CMPS147">CMPS 147 - COMPUTER SCIENCE I</a> (HRS 4)</li>
      <li><a href="#gened">General Education Requirement</a> (HRS 4)*</li>
      <li>Total: (HRS 8)</li>
    </ul>
    <h4>Spring Semester</h4>
    <ul>
      <li>Major: <a href="https://catalog.ramapo.edu/courses/MATH237">MATH 237 - DISCRETE STRUCTURES</a> OR <a href="https://catalog.ramapo.edu/courses/MATH205">MATH 205 - MATHEMATICAL STRUCTURES</a> <strong>WI</strong> (HRS 4)</li>
      <li>Career Pathways: <a href="https://catalog.ramapo.edu/courses/PATH001">PATH 001 - CAREER PATHWAYS MOD 1</a></li>
      <li>Total: (HRS 4)</li>
    </ul>
  </div>
  <p><strong>Total Credits Required: </strong>128 credits<br><strong>GPA:</strong> 2.0</p>
  <p><b>*General Education courses</b> can be done in any order.</p>
  <div class="collapsableContent"><div class="collapsableTitle">Global Awareness (+W)</div><div class="c_content">
    <p><a href="https://catalog.ramapo.edu/courses/INTD299">Global Awareness</a> or Honors Global Awareness</p></div></div>
  <p>+W: Students transferring in with 48 or more credits are waived from these general education requirements.</p>
</div></body></html>`;

test('a plan page keeps every semester line, placement, total, GPA, general education list and note', () => {
  const page = parseGraduationPlan(PAGE, `${PLAN}/snh/computer-science/`);
  assert.equal(page.title, 'Computer Science');
  assert.equal(page.applicability, 'This recommended Graduation Plan is applicable to students admitted into the major during the 2026-2027 academic year.');
  assert.deepEqual(page.documents, [{ name: 'PDF', url: 'https://www.ramapo.edu/uploads/plan.docx.pdf' }, { name: 'Create My Plan (.doc)', url: 'https://www.ramapo.edu/uploads/plan.docx' }]);
  assert.deepEqual(page.placement, [{ title: 'Math Placement', sequences: ['MATH 021/022 to MATH 024 to MATH 110-121'] }]);
  assert.deepEqual(page.terms.map(term => [term.year, term.term, term.totalHours, term.items.length]), [['First Year', 'Fall Semester', 8, 2], ['First Year', 'Spring Semester', 4, 2]]);
  assert.deepEqual(page.terms[0].items[0], { category: 'Major', text: 'CMPS 147 - COMPUTER SCIENCE I', courses: ['CMPS 147'], hours: 4, writingIntensive: false });
  assert.deepEqual(page.terms[0].items[1], { category: null, text: 'General Education Requirement *', courses: [], hours: 4, writingIntensive: false });
  const choice = page.terms[1].items[0];
  assert.deepEqual([choice.courses, choice.writingIntensive, choice.hours], [['MATH 237', 'MATH 205'], true, 4]);
  // A line without hours keeps no hours rather than a guessed value.
  assert.deepEqual([page.terms[1].items[1].category, page.terms[1].items[1].hours], ['Career Pathways', null]);
  assert.equal(page.totalCredits, 128);
  assert.equal(page.gpa, '2.0');
  assert.deepEqual(page.totals, ['Total Credits Required: 128 credits', 'GPA: 2.0']);
  assert.equal(page.graduateCredits, null);
  assert.deepEqual(page.generalEducation, [{ category: 'Global Awareness', waivedForTransfers: true, text: 'Global Awareness or Honors Global Awareness',
    links: [{ name: 'Global Awareness', url: 'https://catalog.ramapo.edu/courses/INTD299' }] }]);
  assert.deepEqual(page.notes, ['NOTE: CRWT and MATH courses are determined by placement testing.', '*General Education courses can be done in any order.',
    '+W: Students transferring in with 48 or more credits are waived from these general education requirements.']);
  for (const line of ['Math Placement', 'Fall Semester', 'Total Credits Required: 128 credits GPA: 2.0', 'Global Awareness (+W)']) assert.ok(page.text.split('\n').includes(line), line);
});

const programs = [
  { catalogCode: 'SN-BS-CMPS', programKind: 'major', type: 'undergraduate' },
  { catalogCode: 'SN-MN-CMPS', programKind: 'minor', type: 'undergraduate' },
  { catalogCode: 'SN-MS-CMPM', programKind: 'major', type: 'graduate' },
  { catalogCode: 'AH-BA-HIST', programKind: 'major', type: 'undergraduate' },
  { catalogCode: 'SS-BS-HIST', programKind: 'major', type: 'undergraduate' },
];

test('a plan links to the one bachelor\'s major its program code names, and variants to their major', () => {
  const [major, variant, uncoded] = planListings(INDEX);
  assert.deepEqual(planPrograms(major, programs), { codes: ['SN-BS-CMPS'], variantOf: null });
  assert.deepEqual(planPrograms(variant, programs), { codes: ['SN-BS-CMPS'], variantOf: 'Computer Science' });
  assert.deepEqual(planPrograms(uncoded, programs), { codes: ['SN-BS-CMPS'], variantOf: 'Computer Science' });
  const history = { ...major, code: 'HIST', name: 'History' };
  assert.match(planPrograms(history, programs).limitation!, /matches 2 catalog majors/);
  const nursing = planListings(INDEX)[4];
  assert.match(planPrograms(nursing, programs).limitation!, /no program code/);
  // Without a code, only the one major with exactly the listing's name is linked, and it says so.
  const named = [...programs, { catalogCode: 'SN-BS-CYBR', name: 'Cybersecurity BS', programKind: 'major', type: 'undergraduate' }];
  const cyber = { ...nursing, name: 'Cybersecurity' };
  const linked = planPrograms(cyber, named);
  assert.deepEqual(linked.codes, ['SN-BS-CYBR']);
  assert.match(linked.limitation!, /exactly that name/);
  assert.deepEqual(planPrograms({ ...nursing, name: 'Cybersecurity Studies' }, named).codes, []);
  assert.deepEqual(planPrograms({ ...nursing, name: 'Cybersecurity with MS in Computer Science 4+1', parent: { name: 'Cybersecurity', url: nursing.url, code: null } }, named).codes, ['SN-BS-CYBR']);
});

test('a redirect must land on a page that names the listed plan', () => {
  const [major] = planListings(INDEX);
  const page = parseGraduationPlan(PAGE, `${PLAN}/snh/computer-science/`);
  const moved = graduationPlan(major, page, `${PLAN}/snh/computer-science/`, programs);
  assert.deepEqual([moved.programCodes, moved.finalUrl, moved.limitations], [['SN-BS-CMPS'], `${PLAN}/snh/computer-science/`, []]);
  assert.equal(moved.id, graduationPlan(major, page, `${PLAN}/snh/computer-science/`, programs).id);
  // The same slug in a new folder is the same page, moved, whatever its title says.
  assert.deepEqual(graduationPlan({ ...major, name: 'Data Science' }, page, `${PLAN}/snh/computer-science/`, programs).limitations, []);
  const elsewhere = graduationPlan({ ...major, name: 'Data Science' }, page, `${PLAN}/snh/data-science-2/`, programs);
  assert.deepEqual(elsewhere.programCodes, []);
  assert.match(elsewhere.limitations[0], /does not name this plan/);
  const flat = withSiteGrouping(planListings(INDEX))[3];
  assert.match(graduationPlan(flat, page, flat.url, programs).limitations[0], /lists the same plan under Computer Science in another cohort/);
});

test('older and 4+1 plan pages state their totals and applicability in their own words', () => {
  const older = PAGE.replace('<p><strong>NOTE:</strong> This recommended Graduation Plan is applicable to students admitted into the major during the 2026-2027 academic year.</p>', '')
    .replace('<p><b>NOTE</b>: CRWT and MATH courses are determined by placement testing.</p>',
      '<p><strong>NOTE:</strong> This recommended Four-Year Plan is applicable to students admitted into the major during the 2023-2024 academic year.</p>')
    .replace('<p><strong>Total Credits Required: </strong>128 credits<br><strong>GPA:</strong> 2.0</p>',
      '<p>Total Undergraduate Credits Required: 128 credits (all courses listed in first four years)</p><p>Major GPA required for undergraduate graduation: 2.0</p><p>Total Graduate Credits Required: 30 credits (listed with MS in fourth year and all fifth year courses)</p>');
  const page = parseGraduationPlan(older, `${PLAN}/snh/computer-science/`);
  assert.equal(page.applicability, 'This recommended Four-Year Plan is applicable to students admitted into the major during the 2023-2024 academic year.');
  assert.deepEqual([page.totalCredits, page.graduateCredits, page.gpa], [128, 30, '2.0']);
  assert.equal(page.totals.length, 3);
  assert.ok(!page.notes.some(note => /Credits Required|GPA/.test(note)));
});

test('credits and GPA are read only from plain statements, and every statement is kept as written', () => {
  const page = (totals: string) => parseGraduationPlan(PAGE.replace('<p><strong>Total Credits Required: </strong>128 credits<br><strong>GPA:</strong> 2.0</p>', totals), `${PLAN}/x/`);
  const graduation = page('<div class="fouryear"><p>Total Credits Required for Graduation: 128 credits</p></div><p>GPA: Must be at least a 2.0</p>');
  assert.deepEqual([graduation.totalCredits, graduation.gpa], [128, null]);
  assert.deepEqual(graduation.totals, ['Total Credits Required for Graduation: 128 credits', 'GPA: Must be at least a 2.0']);
  const nursing = page('<p>Total Credits Required (Transfer Credits plus RCNJ RN/BSN credits): 128 credits</p><p>GPA Required: overall GPA 2.0 and major GPA 2.0</p>');
  assert.deepEqual([nursing.totalCredits, nursing.gpa], [128, null]);
  const teaching = page('<p>Total Credits Required: 134 credits<br>GPA: AMER: 2.0; Teacher Ed: 3.0</p>');
  assert.deepEqual([teaching.totalCredits, teaching.gpa, teaching.totals], [134, null, ['Total Credits Required: 134 credits', 'GPA: AMER: 2.0; Teacher Ed: 3.0']]);
  const joint = page('<p>Total RCNJ Credits: 104.5 credits GPA: 2.85</p>');
  // Ramapo's share of a joint program is not the degree's total, but it stays as written.
  assert.deepEqual([joint.totalCredits, joint.gpa, joint.totals], [null, '2.85', ['Total RCNJ Credits: 104.5 credits GPA: 2.85']]);
});
