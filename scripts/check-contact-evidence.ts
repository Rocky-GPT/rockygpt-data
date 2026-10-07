/**
 * Checks every reviewed office and staff contact against the pages in data/raw, the
 * same way publication does, and lists each value the cited section doesn't state.
 * It also lists each value a cited section states that the entry leaves out ("?"), which
 * is how a published "not found" can hide something the office's own page says.
 * Run it after editing src/reference/directory-contacts.json or recollecting pages;
 * it exits non-zero when publication would withhold anything, and, with --strict, when
 * a cited section states a value the entry leaves out.
 */
import { checkAbsences, checkContactValues, findUnrecordedValues, loadCapturedPages } from '../src/directory/contact-evidence';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../src/directory/static-contacts';

const pages = loadCapturedPages();
let withheld = 0;
let unrecorded = 0;
let confirmedAbsences = 0;
let absenceIssues = 0;
for (const entry of [...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]) {
  const checked = checkContactValues({ phone: entry.phone, email: entry.email, office: entry.office }, entry.evidence, pages);
  const published = Object.entries(checked.values).map(([field, value]) => `${field} ${value}`).join(', ') || 'no values';
  console.log(`${checked.withheld.length ? '✗' : '✓'} ${entry.name}: ${published}`);
  for (const value of checked.withheld) console.log(`    withheld ${value.field} ${value.value}: ${value.reason}`);
  withheld += checked.withheld.length;
  const absences = checkAbsences(entry.notPublished ?? [], { phone: entry.phone, email: entry.email, office: entry.office }, pages);
  for (const absence of absences.confirmed) {
    console.log(`    not published: ${absence.field} (confirmed in ${absence.checks.length} section${absence.checks.length === 1 ? '' : 's'})`);
    confirmedAbsences += 1;
  }
  for (const issue of absences.issues) {
    console.log(`    ✗ not published ${issue.field} ${issue.kind}: ${issue.reason}`);
    absenceIssues += 1;
  }
  for (const missed of findUnrecordedValues({ phone: entry.phone, email: entry.email, office: entry.office }, entry.evidence, pages)) {
    console.log(`    ? ${missed.field} not recorded, but "${missed.section}" of ${missed.url} states ${missed.found.join(', ')}`);
    unrecorded += 1;
  }
}
console.log(`\n${pages.size} captured pages; ${withheld} reviewed value(s) withheld; ${unrecorded} stated value(s) not recorded; `
  + `${confirmedAbsences} absence(s) confirmed, ${absenceIssues} not confirmed.`);
process.exit(withheld || absenceIssues || (unrecorded && process.argv.includes('--strict')) ? 1 : 0);
