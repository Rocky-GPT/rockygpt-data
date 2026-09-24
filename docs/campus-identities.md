# Campus identities and release compilation

Counts in this document describe the snapshot each section names, as examples of the rules. The current numbers for the latest release (entities, relationships, linked records, aliases and coverage issues) are generated from the Brain's graph export into [campus-graph.md](campus-graph.md); regenerate it with `npm run docs:graph -- EXPORT_JSON` after each release.

The Git registry holds persistent UUIDs and reviewed selectors, not duplicated profiles. A release contains exact links to the original contact, schedule, faculty, program and menu records in that release. Names and aliases locate an identity; relationship evidence distinguishes a program's convener and an undated profile-listed course from the identity itself. Menu items are offerings at a venue, not identities of the venue.

`pipeline/commands/publish-current.ts` inserts original rows and artifacts before calling `insertCampusIdentityArtifacts` inside the candidate transaction. The installer refuses active/retired datasets. It writes nine release artifacts: `campus-identities`, `campus-identity-coverage`, `catalog-conveners`, `event-organizers`, `catalog-course-identities`, `program-requirement-groups`, `campus-buildings`, `campus-schools` and `course-subjects`. Repeating compilation/upsert against the same staging dataset is idempotent. Activation remains the established atomic release pointer swap.

Selectors are compiled against candidate rows each time: new menu dates/meals and seasonal exceptions join automatically; a person renamed in the faculty source retains their UUID via a unique institutional email or verified unique profile URL. Candidate record keys remain original. Contradictory identity anchors fail closed, including an old email reassigned to a different profile. Shared directory-page URLs are never unique person anchors. Source fields and differing phone/office values are not overwritten. Alias additions capture newly encountered display names without changing UUIDs.

Office/facility sources expose no durable IDs. Their reviewed schedule-subject names are explicit selectors. A source rename without independent evidence remains unresolved until the selector is reviewed; the existing UUID must be retained. No runtime fuzzy-name or shared-phone joins are performed. New identities need a reviewed registry entry and persistent UUID. The compiler reports new unlinked source records, so refreshes do not silently conceal them.

Faculty artifact reference keys are canonical profile URL plus `#email=<lowercase email>` or, where the source has no email, `#name=<URL-encoded name>`. These are source-record references, not identity IDs. Original faculty array indexes and original source data remain intact. Only explicit profile course codes present in the catalog create `profile_course` relationships. Undated title-only lists remain available in profiles without a guessed catalog association or semester assignment.

## Convener evidence

Legacy normalized program data can fill `convener` with the first faculty member. That field alone does not approve a relationship. The compiler reads only the catalog API's explicit `customFields.rJQmj` Convener field; `xiQxl` is Program Faculty and cannot substitute. The field distinction was checked against the catalog's rendered Faculty/Convener sections, including the [official catalog PDF](https://coursedog-pdfs-public-prod.s3.us-east-2.amazonaws.com/ramapo_banner_ethos/catalog/4b944d6b-6d9c-4953-b3c8-7a3f81c9a33b-ramapo_banner_ethos-catalog-1770843535853.pdf).

The compact `catalog-conveners` artifact retains the original HTML Convener (`rJQmj`) and Program Faculty (`xiQxl`) fields, catalog codes/URLs, raw capture URL and genuine `scrapedAt` timestamp. No other custom field is copied. Export, compilation and publication dates are not substituted for source collection or verification. The linked person is resolved by exact profile URL or a reviewed official HTTP redirect. The redirect evidence is in `src/reference/campus-identity-url-aliases.json`; its observation time establishes only that URL redirect, not freshness of the faculty/program facts.

The reviewed September 21 snapshot has 402 usable identities: 231 people, 13 offices, 10 facilities, four dining venues and 144 programs. It connects 245 contacts, 226 faculty profiles, 77 campus-hours rows, 70 dining-hours rows, 887 menu items and 144 program rows. There are 111 explicit convener relationships and 53 explicit profile-course relationships.

Unresolved evidence remains visible in the coverage artifact:

- Two distinct Nursing MSN catalog programs collide on the same original program record key. Neither is linked until source identifiers can distinguish them; both original rows remain searchable.
- 25 programs have no explicit Convener-field profile URL. Legacy fallback values are not promoted to verified relationships.
- 16 convener references use nine old profile URLs that redirect to missing pages; name similarity is insufficient to connect them.
- 626 profile-listed course entries have no explicit catalog code. They remain undated lists; no current-semester claims follow.
- Only CSI has a confidently supported directory contact plus campus schedule. Birch Tree Inn has its own contact, dining schedule and collector-declared menu feed. Other offices/facilities/venues retain available sections; department or building proximity does not transfer contact details or hours.

Since September 24, 2026 the Library also has both. A reviewed `name` selector links it to two schedules from the Library's own hours page: "Library (Main Building)", which is the Circulation Desk section, and "Research Help Desk", the desk behind the Library's refdesk contact. Each schedule keeps its own name, so an answer can tell the Library's opening hours from the desk's.

Each coverage issue has a `kind`, and its `reason` says why:

- `unlinked_record`: an original record no identity links.
- `missing_connection`: an identity is missing one of its links, relationships or references.
- `no_records`: a reviewed or listed entry has no record in the release.
- `note`: a naming or interpretation note.

Releases compiled before kinds existed carry only the reason.

## Program faculty evidence

A `listed_faculty` relationship means the program's catalog Program Faculty field (`customFields.xiQxl`) links to that person's profile. It is not a convener, an appointment or a current teaching assignment. The published `faculty` array in `programs` is never evidence. It mixes the Convener and Program Faculty fields and adds name matches. For 22 programs it is a scraper heuristic: faculty whose text overlaps the program name, or else the school's first ten faculty. Profile links resolve exactly as convener links do: by exact profile URL, or by a reviewed official redirect. Two URLs for one person produce one listing.

Redirect aliases added for program faculty were checked hop by hop on September 23, 2026 (UTC). Every hop that changed the URL was issued without an `X-Redirect-By: WordPress` header, like the server rules for the `/ca/` → `/ahe/` school move. A hop marked `X-Redirect-By: WordPress` is accepted only when it adds or removes a trailing slash. Any other WordPress redirect is its guess from a similar slug, which is name matching. Two such redirects were rejected (for example `fariba-nosrati/)` → `fariba-nosrati/`). The same check found that the earlier alias for `ca/faculty/yolanda-del-amo-ozaeta` ends in a WordPress guess (`yolanda-del-amo-ozaeta` → `yolanda-del-amo`). It is kept as reviewed and needs a second review.

On the September 22 snapshot, 585 `listed_faculty` relationships cover 107 programs. 77 new redirect aliases resolve 275 listings. 98 listings, over 35 distinct URLs, stay unresolved:
- 30 URLs return 404 or redirect to a missing page.
- 3 profiles belong to people without a person identity.
- 2 redirects are WordPress guesses.

On September 24, 2026, 21 more aliases resolve 87 links on the dev release: 13 conveners and 74 Program Faculty listings. Each old URL was followed hop by hop, and each target profile loaded and named its person.

- 6 are server redirects that land on the person's current profile, like the aliases above.
- 2 are catalog typos around the exact profile path, a stray ")" and a URL written twice. Ramapo reaches them only through WordPress guesses, so a person approved them.
- 13 are profiles from a split school. Ramapo redirects every old `/hgs/` profile to `/ahe/` and every old `/sshs/` profile to `/sssw/`, but these faculty moved to the other school, so the redirect ends in a 404. A person approved each one, because the same URL name is the person's unique current profile under the other school.

19 listings stay unresolved; their people have no person identity. Each alias's `evidence` says which basis applies.

32 programs publish no Program Faculty field. Unresolved listings are reported in the coverage artifact.

The cited catalog's Computer Science convener assertion differs from the [current public major page](https://www.ramapo.edu/majors-minors/majors/computer-science/). The registry relationship means the captured catalog explicitly names that person, not that the catalog outranks every other source or proves a current appointment. The public page is not silently imported into this release.

## Buildings

`campus-buildings` publishes the buildings that published room numbers can place people and offices in. The source is the committed campus map, `data/map/campus-map-data.json`, collected from Ramapo's Concept3D map on August 27, 2026. It is a new repository-static source, `campus-map` ("Ramapo Campus Map"), like the checked-in shuttle timetable: its truth is versioned by the Git revision, and the artifact keeps the map's own collection time and URL.

A map entry becomes a `building` identity only when it has room prefixes and a Concept3D location ID of its own. The ID is a UUIDv5 over that location ID in a fixed namespace, so a rename keeps it. The room-prefix table in the map file (`roomPrefixes`: `A`, `ASB`, `B`, `BC`, `BR`, `C`, `SC`, `D`, `E`, `G`, `AC`, `H`, `LC`/`LIB`/`LIBRARY`, `CPA`, `SS`) is the reviewed room-prefix mapping, approved on September 22, 2026. On September 24, 2026, `LC` was added for the Peter P. Mercer Learning Commons, where the Library staff's `LC-` rooms are, and `SS` for the Sculpture Studios by a person's review: the only `SS` room is a sculpture professor's, and no Ramapo source spells `SS` out. A map location a person approves in `src/reference/campus-identity-reviews.json` is also a building identity, with no room prefixes and `basis: human_reviewed`; Birch Mansion is one (approved September 23, 2026), so "Birch Mansion" resolves to it while "Birch" names the Birch Tree Inn. Map entries that share one Concept3D location, such as the College Park Apartments or the Laurel Hall buildings, get no building identity. Neither do buildings without room prefixes, such as residence halls and fields. Map aliases are not identity aliases yet.

A person's `office_at` and an office, facility or venue's `located_at` relationship come from the identity's own linked contact rooms, or, for an office, facility or venue, from a reviewed location. The whole published room value must be one or more `PREFIX-NUMBER` rooms separated by `/` (`D-224`, `G-203B / ASB-431D`), and every prefix must belong to one building. Other values place someone only through a reviewed reading: an exact published room value, such as "Learning Commons 204A" or "The Lodge", that a person read as naming one building. The review file's `rooms` lists them, the building's published record repeats them as `reviewed_rooms`, and the relationship still cites the contact's own published office. Building names and other free text never place anyone, and neither does the map's own office list, whose room verifier is unreliable. A location is not a claim about a school, a host or an owner.

A reviewed location in `src/reference/campus-identity-reviews.json` places an identity that has no published room. It names the identity's persistent ID and the building's Concept3D location, quotes an official page's statement and its URL, and records who approved it and when. The statement, its URL and the review date go on the building's published record as `reviewed_locations`, and the `located_at` relationship cites that field, so a reader can recheck it there. The Brain accepts this evidence only for `located_at`, and describes it as a reviewed placement, not a room match. The Library is placed this way: the campus-hours page heads its section "Library in the Peter P. Mercer Learning Commons", and the Library's directory entry publishes no room. A Brain that predates this evidence rejects a registry that contains it, so deploy the Brain before a release with a reviewed location.

On the September 22 snapshot there are 14 buildings, 201 `office_at` relationships for 200 people and 9 `located_at` relationships for offices. Three rooms stay unresolved: "Learning Commons 204A", "The Lodge" and "SS-106". The Berrie Center building shares its name with the Archway organization "Berrie Center". Both identities are kept, so a name lookup asks which one is meant; they are never merged by name.

On September 24, 2026, an offline compile of the dev release with `LC`, `SS`, the Library's reviewed location and the two reviewed readings has 16 buildings, 220 `office_at` and 11 `located_at` relationships, and no unplaced contact room. The 17 Library staff with `LC-` rooms, Cathy Moran Hajo ("Learning Commons 204A") and the Library itself are in the Peter P. Mercer Learning Commons, Housing & Residence Life ("The Lodge") is in The Lodge (CPA), and Joel Weissman ("SS-106") is in the Sculpture Studios.

## Schools

School identities are Ramapo's current schools, as its official schools page (https://www.ramapo.edu/academics/schools/) lists them:
- Anisfield School of Business (ASB)
- School of Social Sciences and Social Work (SSSW)
- School of Science, Nursing, and Health (SNH)
- School of Arts, Humanities, and Education (AHE)

`src/reference/campus-schools.json` is the reviewed list, approved on September 23, 2026. Each school has a persistent ID, its official page and the abbreviation that page publishes. The same file records the former names the catalog and Archway still publish, as reviewed legacy names with evidence:
- School of Theoretical and Applied Science → SNH (`/tas/` redirects to `/snh/`).
- School of Contemporary Arts → AHE (`/ca/` → `/ahe/`).
- School of Humanities and Global Studies → AHE (`/hgs/` → `/ahe/`).
- School of Social Science and Human Services was split. `/sshs/` redirects to `/sssw/`, and the AHE page lists the education programs the catalog still files under it. It is a legacy name of both SSSW and AHE, so a lookup by that name asks which is meant.

The capture is a new repository-static source, `ramapo-schools` ("Ramapo Schools"), published the same way as the campus map.

Each school's aliases are its abbreviation and its legacy names. The Archway directory groups that publish a former school name ("School of Contemporary Arts", "School of Humanities and Global Studies") and the Anisfield group are linked to their current school by exact record key, as reviewed in the file. They are no longer separate organization identities.

`part_of` places people and programs in schools:
- **Programs:** through the catalog's school name, only when it names exactly one current school. Programs under the split School of Social Science and Human Services, and the three "Interdisciplinary" programs, are not placed.
- **People:** through the current school name their own faculty profile publishes. The directory's "(Adjunct)" marker is kept as a status; a profile marked "(Retired)" is not placed in a school. "Library Faculty & Staff" is not a school.

On the September 22 snapshot there are 4 schools and 301 `part_of` relationships: 113 programs and 188 people. The School of Social Sciences and Social Work has people but no placed programs, because its catalog programs are filed under the split former school. The ASB school shares its name with the directory office "Anisfield School of Business"; both are kept, so a name lookup asks which is meant.

## Course subjects

A course subject is the code in front of a catalog course: CMPS in CMPS 147. Every course code starts with exactly one, so a subject becomes an identity when the release's catalog has a course under it. Its ID derives from the code, so a renamed department keeps it.

- **Names.** `src/reference/course-subjects.json` is the catalog's department list, captured from the catalog's departments API on the date in `course-subjects.source.json`. A department with the same code names the subject in the catalog's own display form, "Computer Science (CMPS)". A code no department names keeps its code as its name ("LITR"). No name is guessed from course titles.
- **Courses.** Each course is linked by an `includes_course` relationship whose evidence is the course's own published `code` field.
- **Lookup (reviewed September 23, 2026).** A subject answers to its code only: "CMPS" finds Computer Science (CMPS). Its catalog name and the curated short forms ("Computer Science", "CS", "Psych") keep finding programs, or nothing, in lookup. They mean courses only in course search, so the `course-subjects` artifact publishes them as `search_terms`, not identity aliases. The abbreviation rule below skips subjects for the same reason.
- **Coverage.** Two cases are reported:
  - a subject code no department names (39 codes, 478 courses, led by LITR, THEA and LIBS);
  - a department code no course carries (16, such as CYBR and DSCI).

The `course-subjects` release artifact lists each subject with its code, catalog name, display name, search terms and course count. It is the ninth artifact the installer writes, and its static source is `course-subjects`.

## Published aliases and status

After compilation, each identity gains the aliases its own name and linked records publish. No rule matches one entity's name against another's. An alias several identities share stays on each of them, and a lookup by it asks which one is meant.

- **Department:** an office, facility or venue's own directory entry publishes a department. Examples are "Potter Library" for the Library, "Public Safety" for both Public Safety entries, and "Office of the Registrar". The contact lookup has always treated this as an alternative name. A person's department never names the person.
- **Abbreviation:** a name ending in an uppercase abbreviation in parentheses gives both the abbreviation and the name without it: "SC" and "Student Center" from "Student Center (SC)"; "EDIC"; "XAE".
- **Program family:** a catalog program name ending in a degree designation gives the name without it. The designations are BA, BS, BSN, BSW, MA, MS, MSN, MBA, MFA, MPP, MSW, DNP, Minor, 4+1 and -Graduate Certificate. Every program sharing that name gets the alias, so "Computer Science" names the BS, MS, Minor and 4+1, and a lookup asks which. A remainder ending mid-phrase gives none ("Nursing RN to BSN").

On the September 22 snapshot this adds 152 aliases: 131 program families, 9 departments and 12 abbreviation aliases.
- **Human-reviewed aliases:** a colloquial name no source publishes is added only through `src/reference/campus-identity-reviews.json`, by persistent ID. Each entry records who approved it and when. The coverage report lists these separately as `human_reviewed_aliases`, apart from source-derived aliases.
  - Today there is one: "Birch" → Birch Tree Inn, approved on September 23, 2026, because campus language uses it.
  - An entry whose identity is absent or renamed is reported, not applied.
- **Retired status:** a person whose own contact record publishes status `retired` gets `status: {state: "retired", evidence}`, citing that record's `status` field. 21 people are retired; absence of a status publishes nothing about a person.

### Why each alias exists

The coverage report's `alias_sources` lists every alias in the registry with the rule that put it there. Each alias carries one or more sources, and a source names its `basis`:

| Basis | Where the alias comes from | Evidence recorded |
| --- | --- | --- |
| `identity_map` | The reviewed identity map (`src/reference/campus-identities.json`) | none |
| `record_name` | The name a linked source record publishes | that record's `name` field |
| `department` | The department on the identity's own directory entry | that entry's `department` field |
| `abbreviation` | The abbreviation in parentheses in the identity's own name, or the name without it | none |
| `program_family` | The program name without its degree designation | none |
| `school_abbreviation` | The reviewed school entry | the school's official page |
| `school_former_name` | A former name the school replaced | the recorded evidence, such as a redirect |
| `event_title` | The event's published title, without its date | the event record's `title` field |
| `human_reviewed` | A person's approval in `campus-identity-reviews.json` | the review date and note |

An alias no rule recorded fails the compile, so the list always covers the whole registry. On the September 23 release it lists all 625 aliases. The development UI's Aliases page (`/data/aliases`) reads it through the Brain.

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

Directory categories `Student Organization`, `Honor Society`, `Greek Life`, and `Office Sponsored Organization` become `club` identities. Every other directory group (departments, teams, residence halls, schools and seminars) becomes an `organization` identity, under the same group-ID bridge. Both kinds derive their ID from the Archway group ID with the same `club` label, so a group Archway recategorizes keeps its ID; the continuity check treats a club becoming an organization, or back, as the same group. A non-club group whose name exactly matches a reviewed identity's name or alias, or the department that a reviewed office, facility or venue's own contact record publishes, gets no second identity: it is reported as needing a reviewed link, so that name keeps resolving to the reviewed record. Today that covers the Archway *Center for Student Involvement*, *Anisfield School of Business*, *Public Safety*, *Potter Library*, *Counseling Services* and *Center for Student Success* groups. Directory groups are never merged with offices or facilities by name.

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

## Catalog course identities and requirement groups

The identity compiler also writes two artifacts that every release installs alongside the other four.

`catalog-course-identities` publishes one canonical ID per `courses` catalog key. This repository now owns course IDs; the Brain reads them instead of deriving its own. The derivation is the Brain's original one, reproduced byte for byte: a UUIDv5 in the RFC 4122 URL namespace over Python's `json.dumps(["rockygpt", "course", "academic-programs", code])`. On the September 22 snapshot all 3,344 course IDs are unchanged. Do not change the derivation; golden values in `course-identities.test.ts` pin it.

`program-requirement-groups` models program requirements as contextual records built from the release's own `programs` artifact:

- One `requirement_group` record per distinct published section. Identical sections are one shared record: the 576 General Education sections are 9 groups, and 1,007 sections are 389 groups in total. Group IDs are UUIDv5 values over the section's published content, so an unchanged section keeps its ID.
- Each record keeps the published rule tree (condition, count, credits, items with their and/or logic, nested sub-rules), the course list and `selectCount`, and any note, such as waivers and placement conditions, verbatim. Each path it came from is listed with the program and catalog code.
- `choose` is derived only for unambiguous forms: `all`, `at_least N` of a node's items or sub-rules, or `minimum_credits N`. Combinations such as "any of" with a count, or "all of" with a count, keep their published fields with `choose: null` and are reported, not guessed.
- Edges: a program `requirement_group` edge (with section order and the program section's path in the `programs` artifact) and a group `requirement_option` edge to each catalog course, carrying the option's exact position and its item's logic. An option is never an unconditional requirement.
- Course codes resolve only by exact match to a catalog key. Other codes stay as published, unlinked and reported; on September 22 there were two, both opaque catalog IDs rather than course codes.
