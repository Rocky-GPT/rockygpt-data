# Ingestion fixes, rebuild and live verification — 23 September 2026

**The corrected release is active in the local running app:** `dev-profiles-ingestion-20260923-r2`, activated at approximately 20:36 UTC. The previous local database and immutable Brain build remain available for rollback. Production and cloud storage were not changed.

This report follows the [initial ingestion audit](2026-09-23-ingestion-audit.md). That document records the pre-activation findings; its pending rebuild and club-refresh status is historical. This follow-up reports what actually changed, what is now served, and what remains unresolved. Source uncertainty is not counted as a collector defect. Passing publication gates does not establish that every statement on an official page is correct.

## FOUND

The initial audit's confirmed source-fidelity defects included dropped catalog rules, unsupported catalog enrichment, incorrect closure handling, invented empty menu captures, unsupported food flags, lost event-detail joins and club IDs, calendar duplicates, omitted shuttle stops and unsafe raw replay. Their code fixes are now included in the rebuilt local release. The following additional problems were established during rebuild and live verification.

| Priority | Confirmed problem and reproducible evidence | Current disposition |
| --- | --- | --- |
| P1 | **Program identifiers no longer matched the current catalog.** Replaying current primary records with the old selectors initially lost 123 of 144 program identities. School/name record keys also collided for same-name degree paths. The continuity gate correctly blocked that candidate. | Explicit, evidence-backed selector reconciliation preserves 129 existing identities; five new-to-capture programs receive new UUIDs. Program source keys now use `catalog:<catalogCode>`. Ambiguous legacy keys are not resolved by first match. See the [review and examples](../program-identity-migration-20260923.md), [reconciliation](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/src/data-v2/program-identity-reconciliation.ts:60) and [record keys](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/src/data-v2/program-records.ts:10). Unresolved mappings remain below. |
| P2 | **The first corrected hours candidate removed known facilities when their schedules could not be verified.** Rebuilding the graph therefore lost facility identities as a side effect of withholding unsupported hours. | Retain verified names, source citations and explicit unknown-hour records. Strip rejected clock values, closure claims and validity dates from those records; preserve originals in the omission evidence. All ten prior facility identities survive. See [unknown-hours projection](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/ingestion/unverified-hours.ts:16) and [general campus source parsing](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/ingestion/campus-hours.ts:328). |
| P2 | **Four unsupported free-food flags remained in fresh event replay.** Joining separate page sections combined free admission with a food-related title. Events `1410989`, `1411022`, `1409914` and `1409916` reproduced the problem. | Preserve section boundaries before food classification. On the same 316-event capture, flags fall from ten to six; event descriptions remain. [Event replay](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/ingestion/archway-events.ts:365). |
| P2 | **Brain's real SQL omitted the per-facility citation.** A mocked row containing `source_url` concealed the missing selection. Generated hours metadata also used a Markdown format the chunker did not recognize. | Select the citation in real SQL, retain compatibility with databases predating migration 021, and recognize the generated metadata. Tested against old and new database schemas and through actual profiles. [SQL selection](/Users/danielrajakumar/code/RockyGPT/rockygpt-brain/src/rockygpt_brain/retrieval/processing.py:54). |
| P2 | **Campus Graph relationship evidence immediately closed in the development UI.** Clicking History's relationship evidence reproduced it. React Strict Mode cleanup queued a native close event that arrived after reopening. | Only clear the selected evidence when the actual dialog is closed. Browser verification covers opening, closing, reopening and Escape. [Dialog lifecycle](/Users/danielrajakumar/code/RockyGPT/rockygpt-dev/components/identities/ProjectionGraph.tsx:104). |
| P3 | **Eight club calendar exports were attempted as HTML detail pages and recorded as failures.** Their content was `text/calendar`. | The collector now skips calendar exports in HTML detail crawls; the retained capture still records the eight earlier attempts. This does not claim calendar-file ingestion is implemented. [Collector](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/ingestion/archway-clubs.ts:694). |

## FIXED

All fixes above and the initial ingestion fixes are committed and pushed on the existing service `dev` branches. The running Brain uses `2af97f745e90ec360fd614fc7ec92c590b57181c`; the rebuilt dataset was published from data commit `2d490ec` (including `8a84ea6` and `d08ca17`); the dev UI fix is `619ca3a4dadce5bcefdfc655f75d14384600938b`. Later documentation commits do not change that published-code provenance.

The complete club crawl now persisted successfully: 255 groups, 228 crawlable scopes and 1,891 recorded crawl outcomes (1,868 successful pages, 15 HTTP 404s and eight calendar exports rejected as HTML), captured at 20:14:52 UTC. The earlier disk-full failure and August fallback are no longer the active release's state. Campus hours were captured from three official pages at 20:33:38 UTC. Other dynamic source families were also freshly collected on September 23.

The rebuild applied the hours evidence schema migration, regenerated normalized records, public artifacts and documents, published the graph and activated a new local database. Repository-local generated artifacts were synchronized to the published capture; their previous versions were archived first.

| Active data family | Verified published result |
| --- | --- |
| Catalog | 140 source programs; 134 canonical program identities; 2,693 active courses; all 649 visible source requirement-rule nodes retained |
| Faculty and contacts | 226 faculty profiles; 245 structured contact rows |
| Events | 316 listings; 250 public details/descriptions; six explicitly supported free-food flags |
| Clubs | 255 unique source group IDs retained |
| Campus hours | 13 places × seven weekdays = 91 rows; four places have usable schedules, nine explicitly have unknown hours; all 91 rows retain citations and notes |
| Dining | 70 hours rows; 874 menu rows on seven captured service dates, September 23–29 |
| Calendar | 106 distinct events across seven terms |
| Shuttles | Four routes, 51 trips and 167 stop visits |
| Documents | 14 documents, 3,672 chunks and 24 release artifacts |
| Graph | 3,758 canonical nodes; 4,320 direct relationships; 365 contextual requirement groups and 4,395 record edges |

**Continuity was checked against the actual previous active release.** Thresholds were not relaxed. Narrow checks distinguish explicit source changes from unexplained loss: 710 previous course keys are explicitly inactive in the current API, explaining 660 disappearing course relationships and 14 subjects with no remaining active courses. Twenty-seven convener replacements have retained old/current source fields and uniquely resolved faculty-profile evidence. See [inactive-course checks](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/src/data-v2/identity-continuity.ts:127), [convener checks](/Users/danielrajakumar/code/RockyGPT/rockygpt-data/src/data-v2/convener-continuity.ts:102) and the [full publication evidence](/Users/danielrajakumar/code/RockyGPT/.local-logs/profile-feature/ingestion-rebuild-20260923/rockygpt-ingestion-published-quality.json).

Six program successors explicitly marked inactive were retired from the active seed, with their complete UUID entries retained in the review artifact. Twenty-nine old event occurrences had passed. These are supported projection changes, not evidence of permanent institutional program closure or event cancellation. Remaining ordinary losses are still counted by the gate: ten programs, one organization and one event; the existing limits pass. All ten previous facility identities remain.

Verification completed:

- Data: **231 passed, five skipped**; typecheck, production build and targeted ESLint passed. Strict raw freshness/provenance, replay, publication quality and continuity checks passed.
- Brain: **768 passed, 41 skipped**, with one existing Starlette/httpx deprecation warning. Actual SQL was separately exercised against pre-migration and migrated databases.
- Dev UI: **12 graph tests passed**, TypeScript and targeted ESLint passed. Actual browser checks covered search/navigation, History's relationship evidence and Bookstore/Sharp hours and citations.
- Actual `GET /readiness`, `/v1/dev/graph/collections`, `/v1/dev/graph/knowledge` and `/v1/dev/graph/export` returned HTTP 200. Every collection reported available. All **8,715 exported edges** had valid endpoints; there were zero dangling edges and duplicate-ID checks passed. The graph reports zero unresolved published relationships; omitted or uncertain source bindings are separately recorded as coverage diagnostics.

The Campus Graph section works in the exercised flows after the dialog fix. Bookstore and Sharp retain their identities, display “Hours unavailable” with the reason, and cite the correct source; Sharp links specifically to athletics. This is a bounded browser verification, not a claim that every UI state or performance scenario has been tested.

## NOT FIXED

The following remain visible limitations of the active local data:

- **Program coverage:** 11 old seed selectors remain unresolved; ten previously active program identities no longer publish. Six current program records lack canonical identities: four undeclared entries, `AH-BS-EETA` and `AH-BS-PEDS`. The full source records remain available. No speculative predecessor merge was applied.
- **Unknown schedules:** nine places have no sufficiently supported current schedule. Their presence and citations are retained, but the app cannot supply verified opening times for them.
- **Unavailable public details:** all 66 remaining event-detail requests were independently classified as redirects to private-event signup. The 250 public details give 79.1% coverage, above the existing 75% gate. Missing private content is not a confirmed scraper failure, and no authorization bypass was attempted. [Per-event evidence](/Users/danielrajakumar/code/RockyGPT/.local-logs/profile-feature/ingestion-rebuild-20260923/rocky-event-failure-classification-20260923.json).
- **Broken source links:** 15 club detail 404s arise from malformed relative social links authored in source pages. Some catalog faculty links also remain broken. Their targets were not guessed.
- **Manual facts:** tuition, printing, emergency/contact seeds and map/reference values were not all independently reverified. Source-level timestamps still do not establish per-fact verification. The 14 published critical facts are not 14 newly audited facts.

The graph's **917 coverage diagnostics are not 917 confirmed bugs**. For example, 626 concern faculty course titles without explicit course codes, 43 concern organizers without captured group IDs, and 25 concern unnamed subject codes. Omitting unsupported joins is a reasonable evidence-preserving trade-off. No load benchmark was performed; observed successful local endpoint timings are smoke checks, not a scalability conclusion.

## NEEDS REBUILD

**None for the fixes in the local running app.** Dataset `dev-profiles-ingestion-20260923-r2` is active in `rockygpt_profiles_dev_ingestion_20260923`; Brain and dev UI serve the verified changes. The first unsuccessful candidate was not activated.

**Production remains unchanged.** Deploying there would require the reviewed code, schema migration and a validated release built for that environment with fresh-enough sources. Local capture archives were preserved, but no R2/S3 raw-archive upload was performed. This report does not represent a production rollout.

## NEEDS SOURCE REVIEW

1. **Resolve hours applicability.** Bradley, Sharp, Auxiliary and Rock Climbing publish Fall schedules without bounded applicability dates. Research Help has contradictory 2025/2026 validity. Administrative Offices and Bookstore have ambiguous seasonal applicability; CSI's September 2022 update is not current validity; J. Lee's has no published schedule. Keep these unknown until authoritative applicability is established. The underlying captures and omission reasons are preserved.
2. **Resolve the remaining catalog mappings and broken faculty URLs.** The [program review](../program-identity-migration-20260923.md) identifies every unresolved case. Civic & Community Leadership Minor explicitly names Kaitlin Sidorsky, but its stale faculty link does not resolve uniquely through the captured profile URL. Sandra Suárez remains listed in the source with a duplicated URL string. These require source correction or an explicitly reviewed alias, not a name-based guess.
3. **Review two listing discrepancies.** Old Becker event `1410807` is absent from the current listing; its still-public detail mixes November 2 with an October 26 description, while current listed event `1410964` consistently says November 2. Old Multicultural Center group `65169` is absent from the current directory and its old path lands on generic campus home; a distinct group `34281` exists. Neither case proves cancellation, rename or identity equivalence. [Captured checks](/Users/danielrajakumar/code/RockyGPT/.local-logs/profile-feature/ingestion-rebuild-20260923/rockygpt-other-relation-loss-source-review.json) and [club continuity review](/Users/danielrajakumar/code/RockyGPT/.local-logs/profile-feature/ingestion-rebuild-20260923/rocky-clubs-continuity-review-20260923.json).
4. **Capture primary Shortline timetable evidence and verify manual facts separately.** Unsupported legacy Shortline timetable results remain removed. Their lack of captured support does not prove every previous time was false.

Other ordinary relationship losses were independently checked: four Bonnie Blake course links point to courses now explicitly inactive; 12 old school memberships have catalog notes moving them to SSSW effective August 26, 2026; seven listed-faculty links are absent from current source fields and the eighth is Sandra's malformed URL. These checks explain the source changes without silently rebuilding unsupported relationships.

Recommended order: address the source-review items above, run a targeted recollection/rebuild when new evidence is available, then review a separate production rollout. Maintain unknown values and explicit diagnostics until the source evidence changes.

## Evidence and rollback

The compact [verification evidence](2026-09-23-ingestion-rebuild-evidence.json) records the active revision, dataset, counts and checks. Durable local evidence is under [.local-logs/profile-feature/ingestion-rebuild-20260923](/Users/danielrajakumar/code/RockyGPT/.local-logs/profile-feature/ingestion-rebuild-20260923): `published-artifacts.tar.gz`, `published-file-hashes.json`, full publication quality/continuity proofs, source discrepancy captures, live API responses and `verification-summary.json`. The archive retains the capture used for this release; later source changes need not reproduce its counts.

Rollback assets include `previous-local-artifacts.tar.gz`, the old database `rockygpt_profiles_dev_subjects_20260923`, dataset `dev-profiles-subjects-20260923` and immutable Brain revision `589ed56054637d0b3fc0ac5662b7fdfbad48cf0c`. They were preserved, not overwritten. From the workspace root, the existing deployment tool can reactivate that runtime:

```sh
rockygpt-brain/.venv/bin/python rockygpt-infra/scripts/deploy-profile-brain-dev.py --revision 589ed56054637d0b3fc0ac5662b7fdfbad48cf0c --database 'host=127.0.0.1 port=55434 dbname=rockygpt_profiles_dev_subjects_20260923 user=brain_campus_reader sslmode=disable' --expected-dataset dev-profiles-subjects-20260923
```

This command is documented for recovery; it was not run after successful activation of the corrected release.
