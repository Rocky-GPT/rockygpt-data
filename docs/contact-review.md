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

The completed 34-office review is retained in
`src/reference/office-contact-review.json` and saved with each release. Publication
stops when one of these reviewed offices has a withheld value, an unconfirmed absence,
a missing source section, an unreviewed discovery or a changed exclusion. It does not
assign newly discovered values automatically.

Reviewed exclusions in `contactReviewExclusions` name the field, value, source section,
reason and exact section-text SHA256. A changed section invalidates the decision. Missing
fields also retain their scope, reason, source capture time and reviewed text hash. A
missing shared mailbox can coexist with checked, labelled staff addresses; a staff
address never becomes the general mailbox. A `contactConflicts` assertion is checked like
an addition but remains a separate conflicting assertion in the canonical fact reader.

Preferences require explicit ranking. “Email us with payroll questions” is an instruction,
not evidence that email is universally preferred. A missing preference is reviewed and
stored as not published; it is never defaulted to false.

PDF-only contacts use `fetch:reviewed-contact-documents`. Original PDF bytes, hash,
requested/final URL and capture time are archived alongside extracted `PDF text` sections.
`normalize:reviewed-contact-documents` replays those bytes without new network requests or
capture times. External Athletics and Valley clinic evidence is accepted only through
its narrowly checked college referral, not by treating arbitrary external sites as campus
authorities.

`src/reference/office-hours-review.json` separately binds reviewed missing weekdays and
validity dates to exact captured schedule sections. An omitted weekday is not “Closed”,
and an undated Summer schedule does not establish today's hours. Conflicting published
schedules remain conflicting.
