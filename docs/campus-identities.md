# Campus identities and release compilation

The Git registry holds persistent UUIDs and reviewed selectors, not duplicated profiles. A release contains exact links to the original contact, schedule, faculty, program and menu records in that release. Names and aliases locate an identity; relationship evidence distinguishes a program's convener and an undated profile-listed course from the identity itself. Menu items are offerings at a venue, not identities of the venue.

`pipeline/commands/publish-current.ts` inserts original rows and artifacts before calling `insertCampusIdentityArtifacts` inside the candidate transaction. The installer refuses active/retired datasets. It writes four release artifacts: `campus-identities`, `campus-identity-coverage`, `catalog-conveners`, and `event-organizers`. Repeating compilation/upsert against the same staging dataset is idempotent. Activation remains the established atomic release pointer swap.

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

`SNAPSHOT_JSON` holds source rows (`campus_contacts`, `campus_hours`, `dining_hours`, `menu_items`, `programs`, `clubs`, `events`) and `artifacts` keyed by artifact name. `loadIdentitySnapshot` reads that shape from a chosen dataset. The offline command never changes a database. The emitted artifacts are installed only into a complete inactive candidate; no separate entities table or destructive migration is needed.

Before activation, the publisher compares the candidate registry with the active release's (`verifyIdentityContinuity`). A persistent ID that changes kind fails the publish. So does a kind or relationship type that loses more than 10% of its previous members (at least 2): that catches a broken source, a selector that stopped matching, or a changed ID derivation, while one departure does not stop a daily refresh. Event occurrences whose linked rows have all started, and identities removed from the reviewed seed, are expected losses. Relationships are compared by source, type and target, because evidence row IDs are regenerated each release. The full report, including every unexpected loss, is stored as `identityContinuity` in the release quality summary. A release without a comparable active registry records `baseline: "none"`.

Rollback uses the established previous release/dataset pointer and the previous Brain revision together. Do not run the publisher against a shared production database to activate a dev feature; isolated dev activation is managed by the workspace dev workflow. Artifact hashes and coverage belong to the candidate release and should be verified before activation.

## Clubs and dated event occurrences

The Archway extension uses the same registry and four release artifacts: `campus-identities`, `campus-identity-coverage`, `catalog-conveners`, and `event-organizers`. It adds `club` and `event` kinds and links original `clubs` / `events` records. It does not create a new table or copy complete profiles.

Club IDs are UUIDv5 values in the fixed namespace in `archway-identities.ts`, based on the official numeric Archway group ID. The initial bridge requires a unique exact published website URL in both the original club row and the official raw/published group-ID record. Name, shared email and phone are not identity evidence. Normal club ingestion now retains `clubId`, so subsequent publication can retain identity through name or website changes. Missing or conflicting identifiers remain unresolved. The fixed namespace and source-ID derivation are a persistence contract and must not be changed.

Directory categories `Student Organization`, `Honor Society`, `Greek Life`, and `Office Sponsored Organization` become `club` identities. Every other directory group (departments, teams, residence halls, schools and seminars) becomes an `organization` identity, under the same group-ID bridge. Both kinds derive their ID from the Archway group ID with the same `club` label, so a group Archway recategorizes keeps its ID; the continuity check treats a club becoming an organization, or back, as the same group. A non-club group whose name exactly matches a reviewed identity's name or alias (today the Archway *Center for Student Involvement* and *Anisfield School of Business* groups) gets no second identity: it is reported as needing a reviewed link, so that name stays unambiguous. Directory groups are never merged with offices or facilities by name.

Each event uses its explicit Archway RSVP ID. Distinct IDs remain distinct even when title, date, or the legacy `date:title` key collide. The displayed name includes the published New York date, with the bare title as an alias for ambiguity handling. Renames, rescheduling, and replacement database row UUIDs do not change the persistent event ID. A unique occurrence ID with missing date still has an identity; date remains unknown. Multiple original rows claiming one external occurrence ID fail closed. No recurring-series identity is inferred from titles.

Compiled links may add `source_record_ids`, and relationship evidence may add `source_record_id`. These are original database UUIDs, regenerated against every candidate release, in addition to the unchanged original source keys. Shared keys are accepted only with disjoint pinned row IDs. This disambiguates the five current legacy event-key collisions without rewriting source rows.

`organized_by` targets a club or organization identity only when a captured event page has a unique official group-ID filter, a linked group page, and a matching explicit by-line. `event-organizers` retains a separate assertion per source page/capture with its real `collected_at`, source URL, exact event key and original row ID. An older captured organizer must agree with the current event's organizer text; conflicting source assertions stay unresolved. Repeated agreeing captures retain their timestamps. Organizer/location names, login-protected locations and general page links do not establish organizer, adviser or venue identity relationships.

The public TCG October 1 page capture is preserved in `src/reference/archway-event-identity-captures.json`, including its actual September 21 capture time and original HTML hash. It runs through the same extraction as future `data/raw/events-detail.raw.json` captures. It is historical source evidence, not an event-specific code branch, and cannot silently override a changed future organizer. The existing event collector already preserves page URLs, group-filter links, by-lines and per-page capture times; the publisher now consumes these on every release.

Initial verified coverage against `dev-profiles-full-20260921`: **905 identities**, comprising 402 existing identities, 187 clubs, and all 316 event instances. The new records preserve original IDs, keys and timestamps. Of 254 directory records, 66 non-club categories and Visual Arts Society's missing website identity bridge remain unresolved. One real `organized_by` edge links `TCG Club General Meeting (2026-10-01)` to Trading Card Game Club. There are 56 fully supported captured organizer assertions: 55 target administrative/non-club directory entries and one supports the TCG edge. The other 315 event relationships remain unresolved. These 382 new issues plus the previous 671 produce 1,053 coverage issues; an unresolved relationship does not prevent retrieval of its event profile.

Reproduce compilation without database writes:

```sh
node --import tsx pipeline/commands/compile-identities.ts \
  ../.local-logs/profile-feature/clubs-events-snapshot.json \
  ../.local-logs/profile-feature/clubs-events-identity-bundle \
  data/raw/catalog-programs-api.raw.json data/raw/clubs.raw.json data/raw/events-detail.raw.json
```

The normal publisher performs this same compilation after the candidate's original rows and artifacts exist, installs all four artifacts only in `staging` or `validating`, and refreshes links for newly ingested records. The opt-in PostgreSQL publishing test verifies repeat publication, newly added clubs/events, colliding event keys, rescheduling and regenerated row UUIDs, and rejection of active-release mutation.
