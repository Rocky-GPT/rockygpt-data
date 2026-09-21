# Campus identities and release compilation

The Git registry holds persistent UUIDs and reviewed selectors, not duplicated profiles. A release contains exact links to the original contact, schedule, faculty, program and menu records in that release. Names and aliases locate an identity; relationship evidence distinguishes a program's convener and an undated profile-listed course from the identity itself. Menu items are offerings at a venue, not identities of the venue.

`pipeline/commands/publish-current.ts` inserts original rows and artifacts before calling `insertCampusIdentityArtifacts` inside the candidate transaction. The installer refuses active/retired datasets. It writes three release artifacts: `campus-identities`, `campus-identity-coverage`, and `catalog-conveners`. Repeating compilation/upsert against the same staging dataset is idempotent. Activation remains the established atomic release pointer swap.

Selectors are compiled against candidate rows each time: new menu dates/meals and seasonal exceptions join automatically; a person renamed in the faculty source retains their UUID via a unique institutional email or verified unique profile URL. Candidate record keys remain original. Contradictory identity anchors fail closed, including an old email reassigned to a different profile. Shared directory-page URLs are never unique person anchors. Source fields and differing phone/office values are not overwritten. Alias additions capture newly encountered display names without changing UUIDs.

Office/facility sources expose no durable IDs. Their reviewed schedule-subject names are explicit selectors. A source rename without independent evidence remains unresolved until the selector is reviewed; the existing UUID must be retained. No runtime fuzzy-name or shared-phone joins are performed. New identities need a reviewed registry entry and persistent UUID. The compiler reports new unlinked source records, so refreshes do not silently conceal them.

Faculty artifact reference keys are canonical profile URL plus `#email=<lowercase email>` or, where the source has no email, `#name=<URL-encoded name>`. These are source-record references, not identity IDs. Original faculty array indexes and original source data remain intact. Only explicit profile course codes present in the catalog create `profile_course` relationships. Undated title-only lists remain available in profiles without a guessed catalog association or semester assignment.

## Convener evidence

Legacy normalized program data can fill `convener` with the first faculty member. That field alone does not approve a relationship. The compiler reads only the catalog API's explicit `customFields.rJQmj` Convener field; `xiQxl` is Program Faculty and cannot substitute. The field distinction was checked against the catalog's rendered Faculty/Convener sections, including the [official catalog PDF](https://coursedog-pdfs-public-prod.s3.us-east-2.amazonaws.com/ramapo_banner_ethos/catalog/4b944d6b-6d9c-4953-b3c8-7a3f81c9a33b-ramapo_banner_ethos-catalog-1770843535853.pdf).

The compact `catalog-conveners` artifact retains those original HTML fields, catalog codes/URLs, raw capture URL and genuine `scrapedAt` timestamp. Export, compilation and publication dates are not substituted for source collection or verification. The linked person is resolved by exact profile URL or a reviewed official HTTP redirect. The redirect evidence is in `src/reference/campus-identity-url-aliases.json`; its observation time establishes only that URL redirect, not freshness of the faculty/program facts.

The reviewed September 21 snapshot has 402 usable identities: 231 people, 13 offices, 10 facilities, four dining venues and 144 programs. It connects 245 contacts, 226 faculty profiles, 77 campus-hours rows, 70 dining-hours rows, 887 menu items and 144 program rows. There are 111 explicit convener relationships and 53 explicit profile-course relationships.

Unresolved evidence remains visible in the coverage artifact:

- Two distinct Nursing MSN catalog programs collide on the same original program record key. Neither is linked until source identifiers can distinguish them; both original rows remain searchable.
- 25 programs have no explicit Convener-field profile URL. Legacy fallback values are not promoted to verified relationships.
- 16 convener references use nine old profile URLs that redirect to missing pages; name similarity is insufficient to connect them.
- 626 profile-listed course entries have no explicit catalog code. They remain undated lists; no current-semester claims follow.
- Only CSI has a confidently supported directory contact plus campus schedule. Birch Tree Inn has its own contact, dining schedule and collector-declared menu feed. Other offices/facilities/venues retain available sections; department or building proximity does not transfer contact details or hours.

The cited catalog's Computer Science convener assertion differs from the [current public major page](https://www.ramapo.edu/majors-minors/majors/computer-science/). The registry relationship means the captured catalog explicitly names that person, not that the catalog outranks every other source or proves a current appointment. The public page is not silently imported into this release.

## Hours correctness

Dining formatters preserve meal labels, split periods and midnight endpoints. Missing/malformed times or an empty active seasonal exception mean `Hours unavailable`; they do not mean `Closed` or permit fallback to the regular schedule. Only explicit closure labels establish closure. Student UI and file-mode APIs use the same formatter. Publication carries these semantics into new structured schedule rows. Previously published rows remain unchanged; consumers with the original dining artifact can resolve the source periods and uncertainty without rewriting those records.

## Review and rollback

Read-only export compilation:

```sh
node --import tsx pipeline/commands/compile-identities.ts SNAPSHOT_JSON OUTPUT_DIR data/raw/catalog-programs-api.raw.json
```

`SNAPSHOT_JSON` holds source rows (`campus_contacts`, `campus_hours`, `dining_hours`, `menu_items`, `programs`) and `artifacts` keyed by artifact name. `loadIdentitySnapshot` reads that shape from a chosen dataset. The offline command never changes a database. The emitted trio is installed only into a complete inactive candidate; no separate entities table or destructive migration is needed.

Rollback uses the established previous release/dataset pointer and the previous Brain revision together. Do not run the publisher against a shared production database to activate a dev feature; isolated dev activation is managed by the workspace dev workflow. Artifact hashes and coverage belong to the candidate release and should be verified before activation.
