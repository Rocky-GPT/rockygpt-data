import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { assertFacultyProfileCoverage, parseFacultyProfileHtml, parseLibraryStaffHtml } from './faculty-profile-parser';
import { validateFacultyProfiles } from './schema';

const url = 'https://www.ramapo.edu/snh/faculty/example/';
const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'faculty', `${name}.html`), 'utf8');
const parse = (body: string) => parseFacultyProfileHtml(`<h1>Example Faculty</h1><nav>Unrelated navigation</nav>
  <div id="content-block"><div class="col-lg-12"><h3><img class="facphotoLarge" src="/photo.jpg">Professor</h3>
  ${body}<div class="disclaimer">Site-wide legal disclaimer</div></div></div>`, url, 'School');

test('Ali Al-Juboori strong paragraph headings retain all published source entries', () => {
  const result = parseFacultyProfileHtml(fixture('ali-al-juboori'), url, 'School');
  assertFacultyProfileCoverage(result);
  const profile = result.profile!;
  assert.equal(profile.education.length, 2);
  assert.equal(profile.courses.length, 3);
  assert.equal(profile.researchInterests.length, 6);
  assert.equal(profile.publishedResearch.length, 25);
  assert.match(profile.publishedResearch[0], /A Hybrid Regularization-Based Multi-Frame Super-Resolution Using Bayesian Framework/);
  assert.match(profile.publishedResearch.at(-1)!, /Missing Values Estimation for Skylines in Incomplete Database/);
  assert.match(profile.bio, /Year Joined RCNJ: 2021/);
  assert.match(profile.bio, /Office Hours: MON & WED/);
  assert.doesNotMatch(JSON.stringify(profile), /does not preview, review, censor/);
});

test('h4 profiles retain whole publication paragraphs instead of sentence fragments', () => {
  const result = parseFacultyProfileHtml(fixture('rikki-abzug'), url, 'School');
  assertFacultyProfileCoverage(result);
  const profile = result.profile!;
  assert.deepEqual([profile.education.length, profile.courses.length, profile.teachingInterests.length,
    profile.researchInterests.length, profile.publishedResearch.length], [4, 5, 3, 2, 17]);
  assert.equal(profile.publishedResearch[0], 'Abzug, R, (2024). Identifying Ethical Challenges in the Marketing Mix: Experiential Exercise Themes and Variations. Journal of Business Ethics Education. Forthcoming');
  assert.match(profile.bio, /founding leadership council member of Governance Matters/);
});

test('semantic headings, multiple lists, nested entries and unknown sections retain boundaries', () => {
  const result = parse(`<h2>Education:</h2><ul><li>Ph.D. University</li></ul><p>M.A. University</p>
    <p><span><strong>Courses Taught:</strong></span></p><ul><li>Course One</li></ul><ul><li>Course Two</li></ul>
    <h5>Research Interest/s:</h5><ul><li>Database systems</li></ul>
    <p><strong>Scholarly Activities:</strong></p><ul><li>Invited talk <a href="/talk">Talk page</a></li></ul>
    <h4>Selected Publications:</h4><ul><li>A. Author. Complete citation; two sentences. Journal.
    <ul><li>Translation note</li></ul></li></ul><p>B. Author. Another citation. Volume 2; pages 4–5.</p>
    <p><strong>Work in Progress:</strong></p><p>Unpublished manuscript.</p>`);
  assertFacultyProfileCoverage(result);
  const profile = result.profile!;
  assert.deepEqual(profile.education, ['Ph.D. University', 'M.A. University']);
  assert.deepEqual(profile.courses, ['Course One', 'Course Two']);
  assert.deepEqual(profile.researchInterests, ['Database systems']);
  assert.equal(profile.publishedResearch.length, 2);
  assert.match(profile.publishedResearch[0], /Complete citation; two sentences\. Journal\.\nTranslation note/);
  assert.match(profile.bio, /Scholarly Activities:\n\nInvited talk Talk page \(https:\/\/www.ramapo.edu\/talk\)/);
  assert.match(profile.bio, /Work in Progress:\n\nUnpublished manuscript/);
  assert.doesNotMatch(JSON.stringify(profile), /Unrelated navigation|Site-wide legal disclaimer/);
});

test('publication subgroups and citation notes preserve context without swallowing later presentations', () => {
  const bitz = parseFacultyProfileHtml(fixture('michael-bitz'), url, 'School');
  const reali = parseFacultyProfileHtml(fixture('christopher-reali'), url, 'School');
  assertFacultyProfileCoverage(bitz);
  assertFacultyProfileCoverage(reali);
  assert.equal(reali.profile!.publishedResearch.length, 24);
  assert.match(reali.profile!.publishedResearch[0], /^Monographs\nMusic and Mystique/);
  assert.ok(reali.profile!.publishedResearch.some(entry => /^Peer-reviewed Articles\n/.test(entry)));
  assert.ok(reali.profile!.publishedResearch.some(entry => /^Encyclopedia Articles\n/.test(entry)));
  assert.match(reali.profile!.bio, /Presentations:\n\n/);
  assert.ok(!reali.profile!.publishedResearch.some(entry => entry.includes('Eighth International Conference on Tourism')));
  const manga = bitz.profile!.publishedResearch.find(entry => entry.includes('Manga High: Literacy'))!;
  assert.match(manga, /Translated into Japanese/);
  assert.match(manga, /Reviewed in Education Review/);
  assert.ok(!bitz.profile!.publishedResearch.some(entry => /^Books:\nTranslated into/.test(entry)));
});

test('alternate labels are exact and course subgroups keep source context', () => {
  const result = parse(`<h4>OnEducation:</h4><ul><li>B.A. University</li></ul>
    <h4>ByEducation:</h4><ul><li>M.A. University</li></ul>
    <h4>Teaching Interest/s:</h4><ul><li>Literature</li></ul>
    <h4>Recent Publications (from 2009 to present):</h4><h5>Books:</h5><p>Author. Book.</p>
    <h5>Conference Presentations:</h5><p>Conference talk.</p>`);
  assertFacultyProfileCoverage(result);
  assert.deepEqual(result.profile!.education, ['B.A. University', 'M.A. University']);
  assert.deepEqual(result.profile!.teachingInterests, ['Literature']);
  assert.equal(result.profile!.publishedResearch.length, 1);
  assert.match(result.profile!.publishedResearch[0], /^Recent Publications \(from 2009 to present\):\nBooks:\n/);
  assert.match(result.profile!.bio, /Conference Presentations/);
  const yuster = parseFacultyProfileHtml(fixture('debbie-yuster'), url, 'School');
  assertFacultyProfileCoverage(yuster);
  assert.equal(yuster.profile!.courses.length, 10);
  assert.ok(yuster.profile!.courses.some(entry => /^Undergraduate/.test(entry)));
  assert.ok(yuster.profile!.courses.some(entry => /^Graduate/.test(entry)));
});

test('collapsible sections and external references preserve only the published evidence', () => {
  const result = parse(`<div class="collapsableTitle">Analytical Publications</div>
    <div class="collapsableContent"><ul><li>Published article.</li></ul></div>
    <div class="collapsableTitle">Discography</div><div class="collapsableContent"><p>Recorded album.</p></div>
    <h4>Publications:</h4><p><a href="https://scholar.google.com/example">Google Scholar</a></p>
    <h4>Research &amp; Teaching Interests:</h4><p>Combined interest.</p>`);
  assertFacultyProfileCoverage(result);
  assert.deepEqual(result.profile!.publishedResearch, ['Published article.', 'Google Scholar (https://scholar.google.com/example)']);
  assert.ok(result.diagnostics.some(item => item.reason === 'external_reference' && item.url === 'https://scholar.google.com/example'));
  assert.match(result.profile!.bio, /Discography\n\nRecorded album/);
  assert.match(result.profile!.bio, /Research & Teaching Interests/);
  assert.deepEqual(result.profile!.researchInterests, []);
});

test('empty source sections stay unknown; coverage rejects real text loss and missing profiles', () => {
  const empty = parse('<h4>Research Interests:</h4><h4>Recent Publications:</h4><ul><li>Article.</li></ul>');
  assert.deepEqual(empty.profile!.researchInterests, []);
  assert.ok(empty.diagnostics.some(item => item.reason === 'empty_section' && item.section === 'researchInterests'));
  assert.doesNotThrow(() => assertFacultyProfileCoverage(empty));
  // Two conflicting scalar values cannot silently collapse into one legacy field.
  const conflicting = parse('<h4>Contact Information</h4><ul><li>Email: first@example.edu</li><li>Email: second@example.edu</li></ul>');
  assert.ok(conflicting.diagnostics.some(item => item.reason === 'unretained_content' && item.text === 'first@example.edu'));
  assert.throws(() => assertFacultyProfileCoverage(conflicting), /first@example.edu/);
  assert.throws(() => assertFacultyProfileCoverage(parseFacultyProfileHtml('<h1>Missing content</h1>', url, 'School')), /missing_profile_content/);
});

test('library contact-form usernames are not email addresses; explicit addresses and source links survive', () => {
  const profiles = parseLibraryStaffHtml(fixture('library-staff'), 'https://www.ramapo.edu/library/staff/');
  const normalized = validateFacultyProfiles(profiles);
  assert.equal(normalized.length, 17);
  assert.ok(normalized.every(profile => !profile.email));
  assert.ok(normalized.every(profile => profile.bio?.includes('contact-form')));
  assert.ok(normalized.every(profile => profile.phone && profile.office));
  assert.equal(normalized.find(profile => profile.name === 'Leigh Cregan Keller')?.phone, '201.684.7316');
  assert.equal(normalized.find(profile => profile.name === 'Leigh Cregan Keller')?.office, 'LC-418A');
  assert.match(normalized.find(profile => profile.name === 'Christina Connor')!.bio, /collection-development-form/);
  const explicit = parseLibraryStaffHtml(`<div class="et_pb_blurb_content"><h4 class="et_pb_module_header">Named Librarian</h4>
    <div class="et_pb_blurb_description"><p>Librarian</p><p><a href="mailto:published@example.edu">Email me</a></p></div></div>`, url);
  assert.equal(explicit[0].email, 'published@example.edu');
  assert.ok(explicit[0].bio?.includes('Librarian'));
});
