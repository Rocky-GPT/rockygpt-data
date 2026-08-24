/**
 * @module data-v2/contact-search-terms
 * Extra search vocabulary for contact records, joined into the searchable text.
 *
 * A contact row is searched over `name || department`, which for the campus
 * police is the words "Public Safety" and nothing else. Students do not search
 * that way. Measured against the live service, "campus safety" found the record
 * and "safety escort", "walking alone at night" and "walk me to my car" all
 * returned zero — for a question about walking to a car alone at night, which
 * is the exact service this office advertises.
 *
 * The strict any-term alternatives were already tried and rejected upstream
 * (see search-terms.ts: "bursar office contact" returned the Registrar on the
 * word "office"). Nothing here loosens matching. It enriches the *document* so
 * the existing conjunction has real words to match, exactly as
 * `campus-map-data.json` gives every building its aliases.
 *
 * ## Rules for this table
 *
 * - **Search vocabulary only.** These strings are never rendered, never
 *   returned to a caller, and never presented as a department's official name
 *   or an advertised service. They exist to be matched against.
 * - **Every term must be traceable to the office's own published material.**
 *   The provenance URL belongs in a comment beside each entry. A term nobody
 *   can point to on an official page does not go in.
 * - **Narrow, not generous.** The conjunction is what prevents false matches:
 *   "bursar office contact" cannot reach Public Safety because "bursar" is in
 *   no entry here. A term generic enough to appear in unrelated questions
 *   ("help", "office", "student") would erode that and must be left out.
 */

/**
 * Keyed by the exact `name` of the contact record.
 *
 * Public Safety, from https://www.ramapo.edu/publicsafety/campus-safety-escorts/
 * — "To schedule a safety escort pick-up: Call the Public Safety Department at
 * 201-684-6666 or from the blue light telephones or other security phone
 * boxes." The page is titled "Campus Safety Escorts" and lists the office as
 * Academic Complex C-Wing, C-102, which matches this record's own `office`
 * field. The escort service is the 6666 line, so the escort vocabulary sits on
 * the emergency record rather than the non-emergency one.
 */
export const CONTACT_SEARCH_TERMS: ReadonlyMap<string, string> = new Map([
  [
    'Public Safety (Emergency)',
    'campus safety escort escorts safety escorts walking alone walk to car ' +
      'night escort blue light telephone security phone box police dispatch',
  ],
  [
    // The non-emergency desk, from the same directory entry (secdesk@ramapo.edu).
    // Kept deliberately thinner: routing an escort request here would send a
    // student to the wrong number.
    'Public Safety (Non-Emergency)',
    'campus security non emergency security desk police',
  ],
]);

/** Record names and their extra terms, as parallel arrays for a SQL join. */
export function contactSearchTermArrays(): { names: string[]; terms: string[] } {
  const names: string[] = [];
  const terms: string[] = [];
  for (const [name, extra] of CONTACT_SEARCH_TERMS) {
    names.push(name);
    terms.push(extra);
  }
  return { names, terms };
}
