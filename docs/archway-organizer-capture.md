# Archway organizer capture

Traced against the official listing and event 1409871 on September 22, 2026.

## Where evidence was lost

The public `mobile_ws/v17/mobile_events_list` response includes `clubId`,
`clubLogin`, and `clubName`. `publicListingEvent()` previously kept only
`clubName`. `validateArchwayEvents()` also reconstructed a whitelist without
organizer identifiers. Neither raw/normalized event JSON nor the published
`events` artifact could carry that listing assertion to the identity compiler.

The event detail at https://archway.ramapo.edu/sport/rsvp_boot?id=1409871
explicitly contains a Hosted By Sports Club block with `/Sport/` and
`/events?group_ids=62965`. Generic HTML extraction already retained these links
and the byline on this public page: they were not universally being stripped.
However, the local August detail cache had no capture for this event, and
contained sign-in responses counted as HTTP-200 successes. The active development
release had no event-organizers assertion for this event.

## Capture and storage

- The listing collector preserves the publisher's group ID/login and the actual
  capture time/source URL as `organizerIdentity`. Event validation preserves it
  in raw, normalized and published event JSON.
- Both public and authenticated detail collectors use the same event-specific
  parser. It validates the final response URL against the requested occurrence,
  rejects sign-in/failed responses, and captures a single unambiguous Hosted By
  block before generic HTML flattening. ID, group page and matching byline must
  agree. Relative links use the final response URL.
- `RawPageV1.archwayOrganizers` survives validation, normalization and raw archive
  serialization. An empty array forbids fallback to unrelated page-wide links.
  Old caches without successful scoped captures are refreshed once.
- Identity compilation resolves immutable group IDs against the captured club
  directory and original published club rows. Names are consistency checks,
  never join keys. The listing login, when present, must match the directory URL.
  Conflicting assertions suppress relationships rather than choosing authority.
- Publication stores original event row IDs, group IDs, websites, source URLs and
  capture times in the existing `event-organizers` release artifact. The normal
  staged publisher creates `organized_by` edges alongside that evidence. No SQL
  schema migration or UI change is needed. Active releases remain immutable.

## Verification

The real Hosted By markup is a regression fixture. Tests cover normalization,
JSON round trips, source IDs, listing-only evidence, conflicting sources,
ambiguous groups, unrelated links, invalid timestamps, redirects and sign-in
responses. The PostgreSQL publication test checks stored organizer evidence and
relationships, idempotence, and refusal to modify active datasets.

A live read of 316 listing events preserved 316 organizer IDs. Of their detail
pages, 250 passed event-page validation and 66 failed; failed pages contribute no
organizer evidence. Applying captures to the existing local release's identities
produced 42 organized_by relationships, including Commanders VS 49ers → Sports
Club. Unrelated identity kinds and source records were preserved. Missing or
unapproved group identities still remain unresolved; this change does not infer
new office/department identities from names.
