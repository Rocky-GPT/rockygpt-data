/**
 * Checks every reviewed office and staff contact against the pages in data/raw, the
 * same way publication does, and lists each value the cited section doesn't state.
 * Run it after editing src/reference/directory-contacts.json or recollecting pages;
 * it exits non-zero when publication would withhold anything.
 */
import { checkContactValues, loadCapturedPages } from '../src/directory/contact-evidence';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../src/directory/static-contacts';

const pages = loadCapturedPages();
let withheld = 0;
for (const entry of [...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]) {
  const checked = checkContactValues({ phone: entry.phone, email: entry.email, office: entry.office }, entry.evidence, pages);
  const published = Object.entries(checked.values).map(([field, value]) => `${field} ${value}`).join(', ') || 'no values';
  console.log(`${checked.withheld.length ? '✗' : '✓'} ${entry.name}: ${published}`);
  for (const value of checked.withheld) console.log(`    withheld ${value.field} ${value.value}: ${value.reason}`);
  withheld += checked.withheld.length;
}
console.log(`\n${pages.size} captured pages; ${withheld} reviewed value(s) withheld.`);
process.exit(withheld ? 1 : 0);
