# Source completeness correction — 23 September 2026

This audit was triggered by Ali Al-Juboori's empty research field despite research on his official profile. The previous audit checked internal consistency without adequately comparing source-page content to extraction. That was insufficient. This pass compares actual captured sources, transformed artifacts, and graph consumers separately.

## FOUND and FIXED

| Severity | Confirmed problem | Correction and evidence |
| --- | --- | --- |
| High | Faculty extraction recognized only selected h4 headings, stopped at the first list, and discarded other content while cleaning biography. | Semantic paragraph/bold and h1–h6 headings, observed labels, multiple/nested lists, publication subgroups and unknown sections are retained. Full source-text retention is checked before publishing. |
| High | Ninety typed fields across 39 people were empty despite explicit source entries. | All 90 are populated after replay. Ali now has 25 research entries, 6 research interests and 3 courses. His page uses bold paragraph headings. |
| High | Seventeen library staff email addresses were inferred from contact-form usernames. | Inference removed. All 17 published tel links, offices and contact-form links retained. Existing person IDs are preserved through exact named source-row bindings. Unknown addresses remain unknown. |
| Medium | Faculty retrieval documents clipped biographies at 500 characters, research at 5 entries, courses/interests at 10, and omitted education. | Complete retained profile content now reaches retrieval chunks, with each original profile URL and capture time. Citation paragraphs stay whole rather than being split into artificial sentence entries. |
| Medium | The canonical graph omitted existing club contact/social facts and event location/tags/ticket facts. | Exact, unique artifact URL matches supplement canonical facts with source-item locators; original database rows remain available as evidence. Ambiguous matches provide no supplement. |
| Medium | Club mission, member benefits and membership descriptions were dropped during normalization. | All 159 missions, 55 member-benefit descriptions and 255 membership descriptions are preserved from the captured source. |
| Scope extension | Menu ingredients and nutrient values were retained only in raw API captures under the previous selected-field schema. The request to retain all relevant source information makes this a coverage extension, not proof the old schema violated its earlier contract. | All 874 real dated occurrences retain ingredients and all 19 source nutrient fields. Canonical menu facts match exact service date, meal, station, name and source record key. Missing units are not invented, and empty source values remain unknown. |
| Medium | Context generation retained only 8 of 16 Registrar document links; contact counts were also capped. | Arbitrary document/contact caps removed. Tests verify late entries survive document chunking. |
| Scope extension | Campus-hours pages contained service notices, closure definitions, access instructions and Bookstore FAQs outside the previous schedule-only contract. | A separate source-cited context document retains these notices with dates/qualifiers. Withheld or unbounded schedules do not become current hours through this document. |
| Medium | General page extraction kept link labels but dropped their destinations; FAQ questions were omitted and sidebar headings could cause meaningful content to be filtered. | Relevant section/list/table text now preserves source destinations, including standalone action links and fragments. Navigation/footer content is excluded from the main content extraction. Full HTML is captured for replay, and failed collection captures cannot replace successful data. |
| Scope extension | Substantive club detail pages were stored raw but not available to retrieval. | Added 1,111 deduplicated sections from 730 pages with original URLs/dates. Flattened officer text is explicitly not promoted into person-role relationships or current membership claims. |
| Low | Developer scraper metadata described obsolete collectors, endpoints and commands. | Updated descriptions to match the actual HTTP collectors, source uncertainty and current commands. |

## Scope and reproducible evidence

Faculty: all 210 published URLs were fetched successfully: 209 individual profiles and one shared library staff page. These represent 226 published faculty/staff rows. Independent source census and replay checked visible body text, sections, links and contact fields. Results: no detected body-content loss in the 209 individual profiles; all 324 HTTP(S) link occurrences, all 196 Year Joined values and all 162 nonempty Office Hours statements retained. Ninety-five profiles have 279 additional sections such as awards, service, languages, performances and professional history; unclassified material remains in biography with its context.

Typed totals changed as follows:

| Field | Previous | Corrected |
| --- | ---: | ---: |
| Education | 457 | 503 |
| Profile courses | 678 | 836 |
| Teaching interests | 301 | 334 |
| Research interests | 371 | 418 |
| Research entries | 1,167 | 813 |

The research-entry reduction is not 354 missing publications: the old parser split citation paragraphs into sentence fragments. Source-text checks, not a minimum entry count, establish retention. Some mixed-purpose sections properly remain in biography.

Other source checks: 316 captured events remain 316; 2,693 active catalog courses remain 2,693; 140 active program records remain 140. One of 133 program requisite fields was explicitly empty, leaving 132 nonempty fields. The menu API's 892 occurrences contain 18 exact "Have a Nice Day" messages; the 874 real food occurrences are preserved. The club detail capture contains 1,891 pages, of which 1,868 succeeded. The crawl cap is 40 pages per scope; counts after deduplication do not prove every crawl queue was exhausted, so this audit does not certify exhaustive club-site coverage. The six general campus crawls retained all 106 prior URLs, with 104 successful responses and two upstream 404s. These checks establish capture/transform fidelity, not the truth of every institution-authored statement.

Durable local evidence (workspace-relative):

- `.local-logs/profile-feature/faculty-completeness-20260923/`: frozen old normalized and active records, all captured HTML, fetch manifest with hashes/status/timestamps, independent section census, old-empty-field evidence, final parser comparisons, library contact-form checks and README with reproduction steps.
- `.local-logs/profile-feature/source-completeness-rebuild-20260923/`: rollback archive, previous runtime metadata, candidate clone report, validation and activation evidence.
- `data/raw/faculty-sources.raw.json`: source HTML retained by the normal collector, included in raw-source archives and provenance validation.

Code entry points: `ingestion/faculty-profile-parser.ts`, `ingestion/replay-faculty.ts`, `pipeline/quality/faculty-coverage.ts`, `ingestion/generate-faculty-md.ts`, `ingestion/raw-collector.ts`, `ingestion/hours-source-context.ts`, `ingestion/archway-clubs.ts`, `src/data-v2/menu-nutrition.ts`; Brain `retrieval/graph.py`, `processing.py`, `projection.py`, and `menu_artifacts.py`. `src/reference/library-source-binding-review-20260923.json` records the 17 identity-binding corrections and their source basis.

## NOT FIXED / NEEDS SOURCE REVIEW

- The general crawl also encountered existing upstream 404s at `https://www.ramapo.edu/registrar/chat/` and the malformed source link `https://www.ramapo.edu/csi/commuter-affairs/jnesmith@ramapo.edu`. Their failure is recorded; no successful page content was invented.
- Library staff Victoria Sciancalepore's published contact-form link returned HTTP 404; the other 16 forms returned HTTP 200. This is an upstream broken link. It is retained as source evidence; no replacement or email address was invented.
- Some profiles link to external bibliographies/CVs rather than embedding the publications. Their links are preserved, but linked document contents have not been certified as captured. Similarly, this pass preserves source PDF/form links without claiming to have parsed every linked document.
- Source dates and applicability still matter. An undated profile course list does not establish current teaching assignments. Explicit old or unbounded campus schedules remain unavailable as current hours. Capturing a page today does not make its statements current.
- Eight club/organization rows still have no approved canonical entity binding: seven overlap campus offices/schools and require reviewed identity links; Visual Arts Society lacks a unique explicit Archway group ID/website. Their source records remain available. These pre-existing ambiguity safeguards were preserved rather than replaced with name guesses.
- A bounded crawl is not an exhaustive inventory of every campus webpage. This report describes the published faculty corpus, existing source captures and the configured general campus crawl. Static map/school/subject reference data were preserved, not independently recertified by this correction.

## Release and verification

The corrected local release is active:

- Dataset: `dev-profiles-completeness-20260923`.
- Local database: `rockygpt_profiles_dev_completeness_20260923` on `127.0.0.1:55434`.
- Data code revision used to publish: `35bcaa6da31255fb54896e4e14dba81a33b9f975`.
- Brain revision: `a930b9ceaa79caf69bff837ad602a7b1045064f2`.
- Identity artifact hash: `3ed90acbfdbcf7d5e3cb0deed067a23ca5172451e9df17ede50d99de0db3832f`.
- 1,065 registry identities plus 2,693 course identities: 3,758 graph entities, unchanged. All previous relationships survive; 35 additional source-backed profile-course links bring the graph to 4,355 relationships.
- Publication quality passed with no errors or warnings; 16 documents / 5,657 chunks, 24 release artifacts. Source rows: 245 contacts, 91 campus-hours rows, 70 dining-hours rows, 874 menu occurrences, 316 events, 255 clubs, 140 programs.
- Data: 262 tests passed / 5 skipped; build, lint, TypeScript and OpenAPI checks passed. Brain: 815 tests passed / 41 skipped; Ruff and mypy passed.
- Running Dev UI: opened Ali's profile, navigated to all 25 research entries, and expanded the original faculty evidence/source link. Courses and research interests display correctly.

The graph's 1,062 coverage diagnostics are not 1,062 confirmed bugs. For example, newly recovered undated course titles without explicit course codes are retained as profile facts but deliberately not linked to guessed catalog courses.

Full served-data verification results accompany this report in the local evidence directory:

- `live-faculty-verification.json`: 226/226 profiles passed, including all 324 checked source-link occurrences, 452 property evidence records bound to their expected canonical person, and all 17 corrected library contacts.
- `live-nonfaculty-verification.json`: 316/316 events and all 247 currently bound club entities passed canonical API checks. All 874 menu occurrences retained source ingredients and 16,606 nutrient field values; a live Birch Tree Inn menu group also passed API checks. All 1,453 cited club-context chunks and 22 cited hours-policy chunks retained original source URLs, capture dates and qualifiers. The eight club binding limitations above remain explicit.
- `ui-verification.json`: the running Campus Graph displays Ali's recovered profile fields, all 25 research entries and their source evidence.

NEEDS REBUILD: none for this local release. Production activation was not performed. The original active local database and runtime metadata remain available for rollback; published local artifacts are archived and hashed.
