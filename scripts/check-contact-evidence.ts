/**
 * Checks every reviewed office and staff contact against the pages in data/raw, the
 * same way publication does, and lists each value the cited section doesn't state.
 * It also lists each value a cited section states that the entry leaves out ("?"), which
 * is how a published "not found" can hide something the office's own page says.
 * Run it after editing src/reference/directory-contacts.json or recollecting pages;
 * it exits non-zero when publication would withhold anything, and, with --strict, when
 * a cited section states a value the entry leaves out.
 */
import { checkAbsences, checkContactAdditions, checkContactNotes, checkContactValues, checkWebsite, findUnrecordedValues, loadCapturedPages } from '../src/directory/contact-evidence';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../src/directory/static-contacts';

const pages = loadCapturedPages();
let withheld = 0;
let unrecorded = 0;
let confirmedAbsences = 0;
let absenceIssues = 0;
let websites = 0;
let websiteIssues = 0;
let contactNoteIssues = 0;
for (const entry of [...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]) {
  const checked = checkContactValues({ phone: entry.phone, email: entry.email, office: entry.office }, entry.evidence, pages);
  const published = Object.entries(checked.values).map(([field, value]) => `${field} ${value}`).join(', ') || 'no values';
  console.log(`${checked.withheld.length ? '✗' : '✓'} ${entry.name}: ${published}`);
  for (const value of checked.withheld) console.log(`    withheld ${value.field} ${value.value}: ${value.reason}`);
  withheld += checked.withheld.length;
  const additions = checkContactAdditions('additionalContacts' in entry ? entry.additionalContacts ?? [] : [], pages);
  for (const value of additions.confirmed) console.log(`    ${value.label}: ${value.field} ${value.value} (${value.url})`);
  for (const value of additions.withheld) console.log(`    withheld ${value.field} ${value.value}: ${value.reason}`);
  withheld += additions.withheld.length;
  const notes = checkContactNotes('contactNotes' in entry ? entry.contactNotes ?? [] : [], pages);
  for (const note of notes.issues) console.log(`    withheld contact instruction ${note.text}: ${note.reason}`);
  contactNoteIssues += notes.issues.length;
  const values = { phone: entry.phone, email: entry.email, office: entry.office };
  if ('additionalContacts' in entry) for (const addition of entry.additionalContacts ?? []) values[addition.field] ||= addition.value;
  const absences = checkAbsences(entry.notPublished ?? [], values, pages);
  for (const absence of absences.confirmed) {
    console.log(`    not published: ${absence.field} (confirmed in ${absence.checks.length} section${absence.checks.length === 1 ? '' : 's'})`);
    confirmedAbsences += 1;
  }
  for (const issue of absences.issues) {
    console.log(`    ✗ not published ${issue.field} ${issue.kind}: ${issue.reason}`);
    absenceIssues += 1;
  }
  const site = checkWebsite('website' in entry ? entry.website : undefined, pages, 'websiteEvidence' in entry ? entry.websiteEvidence : undefined);
  if (site.confirmed) {
    console.log(`    website: ${site.confirmed.url}`);
    websites += 1;
  }
  if (site.issue) {
    console.log(`    ✗ website ${site.issue.url}: ${site.issue.reason}`);
    websiteIssues += 1;
  }
  for (const missed of findUnrecordedValues({ phone: entry.phone, email: entry.email, office: entry.office }, entry.evidence, pages)) {
    console.log(`    ? ${missed.field} not recorded, but "${missed.section}" of ${missed.url} states ${missed.found.join(', ')}`);
    unrecorded += 1;
  }
}
console.log(`\n${pages.size} captured pages; ${withheld} reviewed value(s) withheld; ${unrecorded} stated value(s) not recorded; `
  + `${confirmedAbsences} absence(s) confirmed, ${absenceIssues} not confirmed; ${websites} website(s) kept, ${websiteIssues} not; ${contactNoteIssues} contact instruction(s) withheld.`);
process.exit(withheld || absenceIssues || websiteIssues || contactNoteIssues || (unrecorded && process.argv.includes('--strict')) ? 1 : 0);
