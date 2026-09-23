# DRAFT — split-school program placements (for review)

**Status: draft for human review. Not published; no compiler or release reads this file.**

The catalog still files 28 programs under the former School of Social Science and Human Services, which was split: its web section redirects to the School of Social Sciences and Social Work (SSSW), and the School of Arts, Humanities, and Education (AHE) now offers its education programs. Until a person approves these placements, the releases do not place these programs in any school.

**Method.** Each program is matched to the current school page's own *Academic Programs* list (https://www.ramapo.edu/sssw/, https://www.ramapo.edu/ahe/) or to the Teacher Education site (https://www.ramapo.edu/te/), which the AHE page links as its Teacher Education Programs. Every listed name below was checked verbatim on the page, observed 2026-09-23T14:29:23Z–2026-09-23T14:29:25Z (UTC). Page hashes are in `split-school-programs-draft.json`.

**Summary:**
- 19 programs → SSSW.
- 5 programs → AHE, plus 1 tentative.
- 3 left unplaced.

| Catalog program | Code | Proposed school | Status | Evidence |
| --- | --- | --- | --- | --- |
| Educational Leadership MA | `MG-MA-EDLD` | — | Leave unplaced | —. No current school page lists Educational Leadership, and its program page names no school. |
| Elementary Education BS | `SS-BS-ELED` | AHE | Proposed | AHE page lists “Elementary Education (Teacher Certification Program)”. The Teacher Education site (/te/), linked from AHE, also lists the Bachelor of Science in Elementary Education. |
| Elementary Education BS (TA to Teacher) | `SS-BS-EETA` | AHE | Proposed | Teacher Education site lists “TA to Teacher”. Listed under the Teacher Education and Certification Program (/te/), which AHE links as its Teacher Education Programs. |
| Law and Society BA | `SS-BA-LAWS` | SSSW | Proposed | SSSW page lists “Law and Society Bachelor of Arts” |
| Neuroscience BS | `SS-BS-NUR5` | SSSW | Proposed | SSSW page lists “Neuroscience M m” |
| Prov-MASE | `SS-BS-PEDS` | AHE | **Tentative** | AHE page lists “Special Education (MASE)”. TENTATIVE: the catalog record has no page; its name suggests the MASE pathway, which AHE lists. Confirm before placing. |
| Psychology BA | `SS-BA-PSYC` | SSSW | Proposed | SSSW page lists “Psychology Bachelor of Arts”. The psychology major page also links to /sssw/. |
| Social Science BA | `SS-BA-SOSC` | SSSW | Proposed | SSSW page lists “Social Science Bachelor of Arts” |
| Social Work BSW | `SS-BSW-SWRK` | SSSW | Proposed | SSSW page lists “Social Work Bachelor of Social Work” |
| Social Work MSW | `MG-MSW-SWRK` | SSSW | Proposed | SSSW page lists “Social Work (MSW)” |
| Sociology BA | `SS-BA-SOCI` | SSSW | Proposed | SSSW page lists “Sociology Bachelor of Arts” |
| Special Education MA | `MG-MA-MASE` | AHE | Proposed | AHE page lists “Special Education (MASE)” |
| Sustainability BA | `SS-BA-SUST` | SSSW | Proposed | SSSW page lists “Sustainability Bachelor of Arts” |
| Special Education 4+1 | `SS-BA-PEDS` | AHE | Proposed | AHE page lists “Special Education (4+1 BS/MA)” |
| SS-BA-Matric Undeclared | `SS-BA-UNDC` | — | Leave unplaced | —. An undeclared matriculation record, not a program a school lists. |
| Climate Change, Policy and Action Minor | `SS-MN-CLIM` | SSSW | Proposed | SSSW page lists “Climate Change, Policy and Action m” |
| Contemplative Studies Minor | `SS-MN-CNST` | AHE | Proposed | AHE page lists “Contemplative Studies m” |
| Crime and Justice Studies Minor | `SS-MN-CJS` | SSSW | Proposed | SSSW page lists “Crime and Justice Studies m” |
| Environmental Studies Minor | `SO-MN-ENST` | SSSW | Proposed | SSSW page lists “Environmental Studies m”. SNH lists Environmental Science, a different program. |
| Food Studies Minor | `SS-MN-FDST` | SSSW | Proposed | SSSW page lists “Food Studies m” |
| Gerontology Minor | `SS-MN-GER` | SSSW | Proposed | SSSW page lists “Gerontology m”. SNH's Adult Gerontology track is a nursing MSN, a different program. |
| Neuroscience Minor | `SS-MN-NUR5` | SSSW | Proposed | SSSW page lists “Neuroscience M m” |
| Psychology Minor | `SS-MN-PSYC` | SSSW | Proposed | SSSW page lists “Psychology Bachelor of Arts M m” |
| Sociology Minor | `SS-MN-SOCI` | SSSW | Proposed | SSSW page lists “Sociology Bachelor of Arts M m” |
| Substance Use Disorder Minor | `SS-MN-SUD` | SSSW | Proposed | SSSW page lists “Substance Use Disorders m” |
| Sustainability Minor | `SS-MN-SUST` | SSSW | Proposed | SSSW page lists “Sustainability Bachelor of Arts M m” |
| Women's Gender & Sexuality Studies Minor | `SS-MN-WGSS` | SSSW | Proposed | SSSW page lists “Women's, Gender and Sexuality Studies m” |
| SS-BS-Matric Undelcared | `SS-BS-UNDC` | — | Leave unplaced | —. An undeclared matriculation record, not a program a school lists. |

## For the reviewer
- **Prov-MASE is tentative.** The catalog record has no page, and only its name points to the MASE pathway that AHE lists.
- **Educational Leadership MA has no current listing.** Leaving it unplaced is safer than guessing.
- **Approving publishes.** Approving moves these into `src/reference/campus-schools.json` as reviewed program placements; only then do releases place the programs.
