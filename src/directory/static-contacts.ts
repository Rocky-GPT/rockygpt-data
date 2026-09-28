/**
 * @module directory/static-contacts
 * Reviewed office and staff contacts for the campus directory.
 *
 * These entries supplement the scraped faculty dataset with campus offices
 * (Registrar, Financial Aid, and so on) and key non-faculty staff whose
 * information is not reliably available in the automated feed.
 *
 * The contacts live in `src/reference/directory-contacts.json`. Each phone,
 * email and office cites the ramapo.edu page section that states it
 * (`evidence`); publication checks every value against that section of the
 * run's capture and withholds what it doesn't state (`npm run check:contacts`
 * runs the same check).
 */

import type { OfficeDirectoryContact, OtherDirectoryContact } from './types';
import contactData from '../reference/directory-contacts.json';

/** Curated office contacts that supplement scraped directory data. */
export const OFFICE_DIRECTORY_CONTACTS: OfficeDirectoryContact[] =
  contactData.office as OfficeDirectoryContact[];

/** Curated non-faculty staff contacts. */
export const OTHER_DIRECTORY_CONTACTS: OtherDirectoryContact[] =
  contactData.other as OtherDirectoryContact[];
