# September 23 catalog identity reconciliation

The July 19 catalog capture and the September 23 19:44:12 UTC capture use different school and program codes. Updating source content alone would lose 123 of the 144 active-release program identities. This review changes explicit Git selectors; it adds no runtime name matcher and does not change the continuity gate.

The complete decisions and source excerpts are in [`program-identity-migration-20260923.json`](../src/reference/program-identity-migration-20260923.json). Each excerpt preserves the original capture timestamp, JSON pointer, record hash, source ID, programGroupId, code, name, status, academic level, change note and nested requirement IDs. SHA-256 values hash `JSON.stringify` of the original parsed capture or record. The current capture came from the official [Coursedog API](https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/programs?limit=500&formatDependencies=true). The review is source-backed agent work, not a claim of human approval.

There are 129 supported current mappings, including unchanged codes. A changed code requires one of these exact combinations, and one unambiguous active target with one old identity owner:

- The same nonempty source programGroupId plus the same name, degree/subject code suffix, or at least two retained requirement IDs.
- At least two retained requirement IDs plus the same name or degree/subject code suffix.
- The same name, degree/subject code suffix and nonempty academic level, plus a source change note explicitly identifying a school change.

For example, History retains its source requirement IDs while `HG-BA-HIST` becomes `AH-BA-HIST`. Art History Minor retains programGroupId `hVzEiH9Jyz8AZ4glfgfF`. Business Analytics Minor becomes Business Analytics and Applied AI Minor while retaining programGroupId `zYWBxZC6LO8gzOVhO1Ep` and four requirement IDs; the source also explicitly describes revising the existing minor. Similar names alone do not establish continuity.

Six exact successors explicitly have source status `Inactive`: Contemporary Arts BA (`AH-BA-CNTP`), Theater BA (`AH-BA-THEA`), Creative Music Technology 4+1 (`AH-BA-PMFA`), Humanities & Global Studies BA (`AH-BA-HUGS`), Educational Leadership MA (`AH-MA-EDLD`) and Medical Imaging Sciences BS (`SN-BS-MDIS`). Their selectors are retired from the active seed because publication includes active programs. Their complete identity entries, UUIDs and old/new codes remain in `retired_entities` for reviewed reactivation. This is catalog-status evidence, not a broader claim that the institution permanently closed those programs.

Five programs with no candidate predecessor in this capture receive new persistent UUIDs: Applied Ethics Certificate, Spanish for Health Care and Human Services Professionals Certificate, Business Essentials Certificate, Cybersecurity Minor and Interdisciplinary Studies BA. “New to capture” does not assert a launch date.

Eleven old entries remain unresolved and keep their existing seed selectors: eight generic undeclared codes, Elementary Education BS (TA to Teacher), Prov-MASE and the sparse duplicate Nursing MSN (`SG-MSN-MSNG`). The other Nursing MSN entry (`SG-MSN-NURS`) has retained requirement IDs supporting `SN-MSN-NURM`. Six current records remain unlinked: four undeclared entries, `AH-BS-EETA` and `AH-BS-PEDS`. They remain available as source records; uncertain predecessor relationships are not guessed.

Against the saved active subjects registry, the candidate has 134 program identities, six explicit seed retirements and ten unexplained prior program losses (the sparse Nursing identity was already unlinked). The unchanged per-kind continuity check allows at most fourteen losses and passes. Full publication must still check all identity kinds and relationships against its actual active baseline.

New program rows use `catalog:<catalogCode>` as their source-record key. The catalog code is trimmed and its source case is preserved. This distinguishes same-name BA/BS Special Education paths and prevents school/name collisions from hiding a correctly reviewed selector. Historical `school:name` keys remain supported only when unambiguous. Requirement groups use the matching source key; compiled references still point to original rows, not guessed names.
