/**
 * @module directory/static-contacts
 * Hand-curated office and staff contacts for the campus directory.
 *
 * These entries supplement the scraped faculty dataset with campus offices
 * (Registrar, Financial Aid, and so on) and key non-faculty staff whose
 * information is not reliably available in the automated feed.
 *
 * The contacts live in `src/reference/directory-contacts.json`. They are
 * curated facts rather than code, so they are kept as data that any language
 * can read.
 */

import type { OfficeDirectoryContact, OtherDirectoryContact } from './types';
import contactData from '../reference/directory-contacts.json';

/** Curated office contacts that supplement scraped directory data. */
export const OFFICE_DIRECTORY_CONTACTS: OfficeDirectoryContact[] =
  contactData.office as OfficeDirectoryContact[];

/** Curated non-faculty staff contacts. */
export const OTHER_DIRECTORY_CONTACTS: OtherDirectoryContact[] =
  contactData.other as OtherDirectoryContact[];
