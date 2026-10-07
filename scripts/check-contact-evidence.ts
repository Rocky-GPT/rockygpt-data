/** Review captured contacts through the same authoritative builder used by publication. */
import { loadCapturedPages } from '../src/directory/contact-evidence';
import { buildStructuredDirectoryContacts } from '../src/directory/structured-contacts';

const pages = loadCapturedPages();
let withheld = 0, unrecorded = 0, confirmedAbsences = 0, absenceIssues = 0;
let websites = 0, websiteIssues = 0, contactNoteIssues = 0, coverageGaps = 0;
for (const contact of buildStructuredDirectoryContacts([], pages)) {
  const evidence = contact.evidence;
  if (!evidence) continue;
  console.log(`${evidence.withheld.length ? '✗' : '✓'} ${contact.name}`);
  for (const item of evidence.withheld) console.log(`    withheld ${item.field} ${item.value}: ${item.reason}`);
  withheld += evidence.withheld.length;
  for (const item of [...evidence.additional_contacts ?? [], ...evidence.contact_conflicts ?? []])
    console.log(`    ${item.label}: ${item.field} ${item.value} (${item.url})`);
  for (const note of evidence.contact_note_issues ?? []) console.log(`    withheld contact instruction ${note.text}: ${note.reason}`);
  contactNoteIssues += evidence.contact_note_issues?.length ?? 0;
  for (const absence of evidence.not_published) {
    console.log(`    not published: ${absence.field} (${absence.checks.length} source sections; ${absence.scope ?? 'reviewed field'})`);
    confirmedAbsences += 1;
  }
  for (const issue of evidence.absence_issues) console.log(`    ✗ not published ${issue.field} ${issue.kind}: ${issue.reason}`);
  absenceIssues += evidence.absence_issues.length;
  if (evidence.website) { console.log(`    website: ${evidence.website.url}`); websites += 1; }
  if (evidence.website_issue) {
    console.log(`    ✗ website ${evidence.website_issue.url}: ${evidence.website_issue.reason}`);
    websiteIssues += 1;
  }
  for (const gap of evidence.contact_review?.unavailable_sections ?? []) { console.log(`    ? coverage gap: ${gap.reason}`); coverageGaps += 1; }
  for (const issue of evidence.contact_review?.exclusion_issues ?? []) { console.log(`    ? exclusion ${issue.value}: ${issue.reason}`); coverageGaps += 1; }
  for (const missed of evidence.contact_review?.unrecorded ?? []) {
    console.log(`    ? ${missed.field} not recorded, but "${missed.section}" of ${missed.url} states ${missed.found.join(', ')}`);
    unrecorded += missed.found.length;
  }
}
console.log(`\n${pages.size} captured pages; ${withheld} reviewed value(s) withheld; ${unrecorded} stated value(s) not recorded; `
  + `${confirmedAbsences} absence(s) confirmed, ${absenceIssues} not confirmed; ${websites} website(s) kept, ${websiteIssues} not; ${contactNoteIssues} contact instruction(s) withheld; ${coverageGaps} coverage gap(s).`);
process.exit(withheld || absenceIssues || websiteIssues || contactNoteIssues || ((unrecorded || coverageGaps) && process.argv.includes('--strict')) ? 1 : 0);
