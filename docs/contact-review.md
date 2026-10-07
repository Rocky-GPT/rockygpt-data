# Reviewing office contacts

Evidence confirmation and omission discovery answer different questions. Confirmation
asks whether the page supports each saved value. Discovery asks what the captured pages
state that has not been saved. Having one phone does not mean every phone was reviewed.

Publication now records `normalization_metadata.evidence.contact_review` and warns when
it needs review. This scans section text, including unlinked numbers, on captured home,
contact, FAQ and staff pages under the office's exact website path, plus explicitly cited
sections. It compares each value with primary contacts, additional contacts and reviewed
contact notes. Missing cited
pages or sections are coverage gaps. Candidates never become facts automatically.

For each office review:

1. Read its home, contact, FAQ and staff pages; ensure the office-pages collector captured
   them. Add supporting citations to `src/reference/directory-contacts.json`.
2. Inspect each candidate's source section. Preserve the published purpose: call, text,
   fax, a staff role, or a particular service. Add a supported contact to
   `additionalContacts`; keep a reviewed explanation in the audit for a candidate that
   belongs to another person/service or is otherwise excluded.
3. Resolve missing captures and inspect fields that remain unknown. Do not turn an
   unscanned page or unreviewed candidate into a “not published” claim.
4. State the scope and unresolved items when reporting a review. A scan with no remaining
   candidates only describes the scanned sections, not the entire office website.

`npm run check:contacts -- --strict` can report candidates and coverage gaps when a data
review is requested. This is a source-data review command, not a code test suite.
Publication retains those diagnostics without making potentially unrelated staff, fax,
resource-list or footer values into office facts. Named places, PDF-only details and pages
outside the bounded scan still require manual review.
