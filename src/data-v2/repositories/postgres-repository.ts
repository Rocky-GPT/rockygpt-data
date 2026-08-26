import type { Pool } from 'pg';
import { contactSearchTermArrays } from '../contact-search-terms';
import { getRuntimePool } from '../../db/runtime-pool';
import type {
  CriticalFactRecord,
  DatasetContext,
  EvidenceItem,
  SourceReference,
} from '../types';
import type {
  AcademicDateRecord,
  ClubRecord,
  ContactRecord,
  CourseRecord,
  DiningVenueRecord,
  EventRecord,
  HoursRecord,
  MenuItemRecord,
  ProgramRecord,
  ShuttleServiceDay,
  ShuttleTripRecord,
} from '../schemas';
import { CURRENT_MENU_VENUE_NAME, diningVenueRecord } from '../dining-venues';
import { V2_SOURCES } from '../sources';
import { courseCredits } from '../course-record';
import type { RockyRepositoryV2, SearchOptions } from './types';

/**
 * The relevance a passage must reach to be returned at all.
 *
 * Measured against this corpus rather than chosen. Gibberish tops out at
 * 0.0043 and words absent from the corpus score 0, while the weakest correct
 * match found — "class withdrawal deadline" onto the calendar entry that
 * answers it — reaches 0.0091. The floor sits between the two.
 *
 * The bands do touch: a plainly off-topic question ("who won the world cup")
 * reaches 0.0104, above real matches at the bottom of their range. No floor
 * separates those, and this one is deliberately set to admit the weak match
 * rather than exclude the off-topic one, for two reasons. A wrong `no_match`
 * is the worse error — a model can decline to use a thin passage, but cannot
 * use one that was never returned. And off-topic questions do not arrive
 * here: this lane is only reached when the planner has already decided the
 * answer lives in a campus document.
 *
 * Re-measure it when the corpus changes size. It is a property of this index,
 * not a constant.
 */
const MIN_RELEVANCE = 0.005;
import { inferProgramKind, parseProgramSearch, type ProgramKind } from './program-search';
import { buildTermFrequencies, searchTermsFor, type TermFrequencies } from './search-terms';
import { campusLocalDate } from '../dining-seasons';

type Row = Record<string, unknown>;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Normalize PostgreSQL timestamp text to the RFC 3339 wire format promised by OpenAPI. */
export function toWireDateTime(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : new Date(typeof value === 'string' ? value : String(value ?? ''));
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error('Repository returned an invalid timestamp.');
  }
  return parsed.toISOString();
}

function requiredDateTime(row: Row, key: string): string {
  return toWireDateTime(row[key]);
}

function optionalDateTime(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined || value === ''
    ? undefined
    : toWireDateTime(value);
}

function sourceFromRow(row: Row): SourceReference {
  return {
    sourceId: requiredString(row, 'source_id'),
    title: requiredString(row, 'source_title'),
    url: requiredString(row, 'source_url'),
    collectedAt: optionalDateTime(row, 'collected_at'),
  };
}

function programKindFromRow(row: Row): ProgramKind | undefined {
  const value = optionalString(row, 'program_kind');
  if (value === 'major' ||
    value === 'minor' ||
    value === 'certificate' ||
    value === 'undeclared' ||
    value === 'other' ||
    value === 'special') {
    return value;
  }
  const name = requiredString(row, 'name');
  return name ? inferProgramKind({ name, degree: optionalString(row, 'degree') }) : undefined;
}

/**
 * Words naming what a table *is*, per table. These describe the question, not
 * any row in it, and the measured frequencies cannot catch them because they
 * never appear inside the records themselves (see search-terms.ts). Keep each
 * list to nouns for the table's own subject — anything that could identify a
 * specific row belongs in the search, not here.
 */
// Extra search vocabulary joined into the contact document; see
// data-v2/contact-search-terms.ts for why it is not a looser match.
const DOMAIN_WORDS: Record<string, ReadonlySet<string>> = {
  clubs: new Set(['club', 'clubs', 'organization', 'organizations', 'org', 'orgs', 'join', 'society']),
  campus_events: new Set(['event', 'events', 'happening', 'happenings', 'going']),
  menu_items: new Set(['menu', 'menus', 'food', 'eat', 'eating', 'option', 'options', 'serving', 'serve', 'served', 'dish', 'dishes', 'meal', 'meals']),
  // "campus" names the institution every one of these records belongs to and
  // appears inside none of them, so frequency pruning measures it as maximally
  // distinctive while it can only ever eliminate. Measured: `q=safety` returns
  // both Public Safety numbers, `q=campus safety` returns nothing, because the
  // conjunction requires a word no record contains.
  campus_contacts: new Set(['campus', 'directory', 'reach', 'call']),
};

export class PostgresRepositoryV2 implements RockyRepositoryV2 {
  /**
   * Word frequencies per searchable table, keyed by dataset so a published
   * release never reads another version's statistics. Computed once per table
   * per process: the tables are small and immutable within a dataset version.
   */
  private readonly termFrequencies = new Map<string, Promise<TermFrequencies>>();
  private readonly pool: Pool;
  /** When set, every read in this view is scoped to one immutable dataset. */
  private pinnedDataset: DatasetContext | null = null;

  constructor(connectionString: string) {
    const pool = getRuntimePool(connectionString);
    if (!pool) throw new Error('DATABASE_URL is required for PostgreSQL repository access.');
    this.pool = pool;
  }

  withDataset(dataset: DatasetContext): RockyRepositoryV2 {
    // A prototype view shares the pool but pins the dataset, so every query
    // (they all resolve ids through getDatasetContext) reads one version
    // without re-resolving active state mid-request (PROB-013).
    const view = Object.create(this) as PostgresRepositoryV2;
    view.pinnedDataset = dataset;
    return view;
  }

  async getDatasetContext(): Promise<DatasetContext> {
    if (this.pinnedDataset) return this.pinnedDataset;
    const result = await this.pool.query<Row>(
      `SELECT id::text, version, activated_at::text
       FROM rockygpt_v2.dataset_versions
       WHERE status = 'active'
       ORDER BY activated_at DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) throw new Error('No active dataset version.');
    return {
      id: requiredString(row, 'id'),
      version: requiredString(row, 'version'),
      activatedAt: requiredDateTime(row, 'activated_at'),
    };
  }

  private async activeDatasetId(): Promise<string> {
    return (await this.getDatasetContext()).id;
  }

  async getCriticalFact(key: string): Promise<CriticalFactRecord | null> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT f.fact_key, f.fact_value, f.verified_at::text, f.valid_from::text, f.valid_until::text,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              f.collected_at::text
       FROM rockygpt_v2.critical_facts f
       JOIN rockygpt_v2.sources s ON s.id = f.source_id
       WHERE f.dataset_version_id = $1::uuid
         AND f.fact_key = $2
         AND (f.valid_from IS NULL OR f.valid_from <= CURRENT_DATE)
         AND (f.valid_until IS NULL OR f.valid_until >= CURRENT_DATE)
       LIMIT 1`,
      [datasetId, key]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      key: requiredString(row, 'fact_key'),
      value: requiredString(row, 'fact_value'),
      source: sourceFromRow(row),
      verifiedAt: requiredString(row, 'verified_at'),
      validFrom: optionalString(row, 'valid_from'),
      validUntil: optionalString(row, 'valid_until'),
    };
  }

  async listDiningVenues(): Promise<DiningVenueRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT DISTINCT h.name
       FROM rockygpt_v2.dining_hours h
       WHERE h.dataset_version_id = $1::uuid
       ORDER BY h.name`,
      [datasetId]
    );
    const names = result.rows.map((row) => requiredString(row, 'name'));
    return [...new Set([...names, CURRENT_MENU_VENUE_NAME])].map(diningVenueRecord);
  }

  async findMenuItems(query: string, meal?: string): Promise<MenuItemRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      'menu_items',
      `SELECT m.meal || ' ' || m.station || ' ' || m.name AS text
         FROM rockygpt_v2.menu_items m WHERE m.dataset_version_id = $1::uuid`,
      (queryText) => this.findMenuItemsMatching(queryText, meal),
      DOMAIN_WORDS.menu_items
    );
  }

  private async findMenuItemsMatching(query: string, meal?: string): Promise<MenuItemRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT m.meal, m.station, m.name, m.calories, m.vegan, m.vegetarian, m.allergens,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              m.collected_at::text
       FROM rockygpt_v2.menu_items m JOIN rockygpt_v2.sources s ON s.id = m.source_id
       WHERE m.dataset_version_id = $1::uuid
         AND ($2::text IS NULL OR lower(m.meal) = lower($2))
         AND ($3::text = '' OR to_tsvector('english',
                m.meal || ' ' || m.station || ' ' || m.name
                -- Diet is stored as booleans, so "vegan options" matched
                -- nothing until these words existed in the index.
                || CASE WHEN m.vegan THEN ' vegan' ELSE '' END
                || CASE WHEN m.vegetarian THEN ' vegetarian' ELSE '' END)
              @@ plainto_tsquery('english', $3))
       ORDER BY m.meal, m.station, m.name
       LIMIT 12`,
      [datasetId, meal || null, query]
    );
    return result.rows.map((row) => ({
      meal: requiredString(row, 'meal'),
      station: requiredString(row, 'station'),
      name: requiredString(row, 'name'),
      calories: optionalString(row, 'calories'),
      vegan: row.vegan === true,
      vegetarian: row.vegetarian === true,
      allergens: Array.isArray(row.allergens) ? row.allergens.filter((value): value is string => typeof value === 'string') : [],
      source: sourceFromRow(row),
    }));
  }

  /** Word frequencies for one table's searchable text, computed once. */
  private async frequenciesFor(
    cacheKey: string,
    sql: string,
    extraParams: unknown[] = []
  ): Promise<TermFrequencies> {
    const datasetId = await this.activeDatasetId();
    const key = `${datasetId}:${cacheKey}`;
    const cached = this.termFrequencies.get(key);
    if (cached) return cached;

    const pending = this.pool
      .query<Row>(sql, [datasetId, ...extraParams])
      .then((result) => buildTermFrequencies(result.rows.map((row) => requiredString(row, 'text'))))
      .catch((error) => {
        // A statistics failure must never break a lookup; an empty table simply
        // prunes nothing, leaving the strict behaviour that shipped before.
        this.termFrequencies.delete(key);
        throw error;
      });
    this.termFrequencies.set(key, pending);
    return pending;
  }

  /**
   * Runs a lookup on the words that can actually identify a record, then once
   * more on every non-generic word if that found nothing. The match itself stays
   * strict — every word must be present — because relaxing it lets one generic
   * word choose the answer.
   */
  private async searchWithPrunedTerms<T>(
    query: string,
    frequenciesKey: string,
    frequenciesSql: string,
    run: (queryText: string) => Promise<T[]>,
    domainWords?: ReadonlySet<string>,
    // Extra vocabulary joined into `frequenciesSql`, so the pruning statistics
    // are measured over the same document the match will run against.
    vocabulary?: { names: string[]; terms: string[] }
  ): Promise<T[]> {
    if (!query.trim()) return run(query);

    let terms;
    try {
      terms = searchTermsFor(
        query,
        await this.frequenciesFor(
          frequenciesKey,
          frequenciesSql,
          vocabulary ? [vocabulary.names, vocabulary.terms] : []
        ),
        domainWords
      );
    } catch {
      return run(query);
    }
    // Nothing identifying survived: the question named the table but no
    // record in it ("what clubs can i join"). Listing the table answers that;
    // re-running the original words only reproduces the empty result that
    // made pruning necessary.
    if (!terms.primary) return run('');

    const primary = await run(terms.primary);
    if (primary.length || !terms.fallback) return primary;
    return run(terms.fallback);
  }

  private async findHours(
    table: 'dining_hours' | 'campus_hours',
    query: string,
    day: string,
    at?: Date
  ): Promise<HoursRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      table,
      `SELECT DISTINCT h.name AS text FROM rockygpt_v2.${table} h WHERE h.dataset_version_id = $1::uuid`,
      (queryText) => this.findHoursMatching(table, queryText, day, at)
    );
  }

  private async findHoursMatching(
    table: 'dining_hours' | 'campus_hours',
    query: string,
    day: string,
    at: Date | undefined
  ): Promise<HoursRecord[]> {
    const toQuery = "plainto_tsquery('english', $3)";
    const datasetId = await this.activeDatasetId();
    // PROB-010: dated exception rows (valid_from/valid_until) apply only when
    // the campus-local date falls inside their window. Rank the eligible rows
    // per venue/day and retain only the governing row; merely sorting seasonal
    // rows first would also return the superseded standard schedule.
    // Without a date only standard rows are visible.
    const onDate = at ? campusLocalDate(at) : null;
    const result = await this.pool.query<Row>(
      `WITH eligible_hours AS (
         SELECT h.*,
                ROW_NUMBER() OVER (
                  PARTITION BY lower(h.name), lower(h.day)
                  ORDER BY
                    (h.valid_from IS NOT NULL) DESC,
                    h.valid_from ASC NULLS LAST,
                    h.valid_until ASC NULLS LAST,
                    h.source_record_key ASC
                ) AS precedence_rank
           FROM rockygpt_v2.${table} h
          WHERE h.dataset_version_id = $1::uuid
            AND lower(h.day) = lower($2)
            AND (
              (h.valid_from IS NULL AND h.valid_until IS NULL)
              OR ($4::date IS NOT NULL AND $4::date BETWEEN h.valid_from AND h.valid_until)
            )
            AND ($3::text = '' OR to_tsvector('english', h.name) @@ ${toQuery})
       )
       SELECT h.name, h.day, h.schedule,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              h.collected_at::text
         FROM eligible_hours h JOIN rockygpt_v2.sources s ON s.id = h.source_id
        WHERE h.precedence_rank = 1
       ORDER BY
         CASE WHEN $3::text = '' THEN 0 ELSE
           ts_rank(to_tsvector('english', h.name), ${toQuery})
         END DESC,
         h.name
       LIMIT 10`,
      [datasetId, day, query, onDate]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      day: requiredString(row, 'day'),
      schedule: requiredString(row, 'schedule'),
      source: sourceFromRow(row),
    }));
  }

  findDiningHours(query: string, day: string, at?: Date): Promise<HoursRecord[]> {
    return this.findHours('dining_hours', query, day, at);
  }

  findCampusHours(query: string, day: string, at?: Date): Promise<HoursRecord[]> {
    // Campus hours carry a validity window now, and the eligibility filter
    // treats a dated row as ineligible unless it is given a date to compare
    // against. Omitting this made every dated row disappear.
    return this.findHours('campus_hours', query, day, at);
  }

  async listCampusHourVenues(): Promise<string[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT DISTINCT h.name
         FROM rockygpt_v2.campus_hours h
        WHERE h.dataset_version_id = $1::uuid
        ORDER BY h.name`,
      [datasetId]
    );
    return result.rows.map((row) => requiredString(row, 'name'));
  }

  findCampusHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]> {
    return this.findHoursByVenue('campus_hours', name, day, at);
  }

  findDiningHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]> {
    return this.findHoursByVenue('dining_hours', name, day, at);
  }

  /**
   * An exact-name fetch, not a text match. A question that has already resolved
   * to a venue cannot come back with a different one, which is the whole point
   * of resolving first.
   */
  private async findHoursByVenue(
    table: 'dining_hours' | 'campus_hours',
    name: string,
    day: string,
    at?: Date
  ): Promise<HoursRecord[]> {
    const datasetId = await this.activeDatasetId();
    const onDate = at ? campusLocalDate(at) : null;
    const result = await this.pool.query<Row>(
      `WITH eligible_hours AS (
         SELECT h.*,
                ROW_NUMBER() OVER (
                  PARTITION BY lower(h.name), lower(h.day)
                  ORDER BY
                    (h.valid_from IS NOT NULL) DESC,
                    h.valid_from ASC NULLS LAST,
                    h.valid_until ASC NULLS LAST,
                    h.source_record_key ASC
                ) AS precedence_rank
           FROM rockygpt_v2.${table} h
          WHERE h.dataset_version_id = $1::uuid
            AND lower(h.day) = lower($2)
            AND h.name = $3
            AND (
              (h.valid_from IS NULL AND h.valid_until IS NULL)
              OR ($4::date IS NOT NULL AND $4::date BETWEEN h.valid_from AND h.valid_until)
            )
       )
       SELECT h.name, h.day, h.schedule,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              h.collected_at::text
         FROM eligible_hours h JOIN rockygpt_v2.sources s ON s.id = h.source_id
        WHERE h.precedence_rank = 1
        LIMIT 10`,
      [datasetId, day, name, onDate]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      day: requiredString(row, 'day'),
      schedule: requiredString(row, 'schedule'),
      source: sourceFromRow(row),
    }));
  }

  async findAcademicDates(query: string): Promise<AcademicDateRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      'academic_dates',
      `SELECT a.title AS text FROM rockygpt_v2.academic_dates a
        WHERE a.dataset_version_id = $1::uuid`,
      (queryText) => this.findAcademicDatesMatching(queryText)
    );
  }

  private async findAcademicDatesMatching(query: string): Promise<AcademicDateRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT a.term, a.date_label, a.title, a.description,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              a.collected_at::text
       FROM rockygpt_v2.academic_dates a JOIN rockygpt_v2.sources s ON s.id = a.source_id
       WHERE a.dataset_version_id = $1::uuid
         AND to_tsvector('english', a.term || ' ' || a.title || ' ' || coalesce(a.description, ''))
             @@ plainto_tsquery('english', $2)
       ORDER BY ts_rank(
         to_tsvector('english', a.term || ' ' || a.title || ' ' || coalesce(a.description, '')),
         plainto_tsquery('english', $2)
       ) DESC
       LIMIT 5`,
      [datasetId, query]
    );
    return result.rows.map((row) => ({
      term: requiredString(row, 'term'),
      date: requiredString(row, 'date_label'),
      title: requiredString(row, 'title'),
      description: optionalString(row, 'description'),
      source: sourceFromRow(row),
    }));
  }

  async findEvents(query: string, now: Date): Promise<EventRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      'campus_events',
      `SELECT e.title || ' ' || coalesce(e.organizer, '') AS text
         FROM rockygpt_v2.campus_events e WHERE e.dataset_version_id = $1::uuid`,
      (queryText) => this.findEventsMatching(queryText, now),
      DOMAIN_WORDS.campus_events
    );
  }

  async findCourses(query: string): Promise<CourseRecord[]> {
    const datasetId = await this.activeDatasetId();
    const compactQuery = query.replace(/\s+/g, '').toLowerCase();
    const result = await this.pool.query<Row>(
      `SELECT course.value->>'code' AS code,
              course.value->>'name' AS name,
              course.value->>'description' AS description,
              course.value->'credits' AS credits,
              course.value->'attributes' AS attributes
       FROM rockygpt_v2.release_artifacts artifact
       CROSS JOIN LATERAL jsonb_each(artifact.payload) AS course(key, value)
       WHERE artifact.dataset_version_id = $1::uuid
         AND artifact.artifact_key = 'courses'
         AND (
           $2::text = ''
           OR lower(regexp_replace(course.value->>'code', '\\s+', '', 'g')) = $3
           OR to_tsvector(
                'english',
                coalesce(course.value->>'code', '') || ' ' ||
                coalesce(course.value->>'name', '') || ' ' ||
                coalesce(course.value->>'description', '') || ' ' ||
                coalesce(course.value->>'attributes', '')
              ) @@ plainto_tsquery('english', $2)
         )
       ORDER BY
         (lower(regexp_replace(course.value->>'code', '\\s+', '', 'g')) = $3) DESC,
         course.value->>'code'
       LIMIT 20`,
      [datasetId, query.trim(), compactQuery]
    );
    return result.rows.map((row) => {
      const code = requiredString(row, 'code');
      const attributes = Array.isArray(row.attributes)
        ? row.attributes.filter((value): value is string => typeof value === 'string')
        : [];
      return {
        code,
        name: requiredString(row, 'name'),
        description: optionalString(row, 'description'),
        credits: courseCredits(row.credits),
        attributes,
        courseUrl: `https://catalog.ramapo.edu/courses/${code.replace(/\s+/g, '')}`,
        source: {
          ...V2_SOURCES.programs,
          title: `${code} - Ramapo Course Catalog`,
        },
      };
    });
  }

  private async findEventsMatching(query: string, now: Date): Promise<EventRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT e.title, e.date_label, e.start_time, e.end_time, e.organizer, e.description, e.event_url,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              e.collected_at::text
       FROM rockygpt_v2.campus_events e JOIN rockygpt_v2.sources s ON s.id = e.source_id
       WHERE e.dataset_version_id = $1::uuid
         AND (e.starts_at IS NULL OR e.starts_at >= $2::timestamptz - interval '1 day')
         AND ($3::text = '' OR to_tsvector('english', e.title || ' ' || coalesce(e.organizer, '') || ' ' || coalesce(e.description, ''))
              @@ plainto_tsquery('english', $3))
       ORDER BY e.starts_at NULLS LAST, e.title
       LIMIT 40`,
      [datasetId, now.toISOString(), query]
    );
    return result.rows.map((row) => ({
      title: requiredString(row, 'title'),
      date: requiredString(row, 'date_label'),
      startTime: optionalString(row, 'start_time'),
      endTime: optionalString(row, 'end_time'),
      organizer: optionalString(row, 'organizer'),
      description: optionalString(row, 'description'),
      eventUrl: optionalString(row, 'event_url'),
      source: sourceFromRow(row),
    }));
  }

  async findClubs(query: string): Promise<ClubRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      'clubs',
      `SELECT c.name || ' ' || coalesce(c.category, '') AS text
         FROM rockygpt_v2.clubs c WHERE c.dataset_version_id = $1::uuid`,
      (queryText) => this.findClubsMatching(queryText),
      DOMAIN_WORDS.clubs
    );
  }

  private async findClubsMatching(query: string): Promise<ClubRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT c.name, c.category, c.website_url,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              c.collected_at::text
       FROM rockygpt_v2.clubs c JOIN rockygpt_v2.sources s ON s.id = c.source_id
       WHERE c.dataset_version_id = $1::uuid
         AND ($2::text = '' OR to_tsvector('english', c.name || ' ' || coalesce(c.category, ''))
             @@ plainto_tsquery('english', $2))
       ORDER BY c.name LIMIT 8`,
      [datasetId, query]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      category: optionalString(row, 'category'),
      websiteUrl: optionalString(row, 'website_url'),
      source: sourceFromRow(row),
    }));
  }

  async findPrograms(query: string): Promise<ProgramRecord[]> {
    // Only the subject text is pruned; the degree and kind filters come from the
    // original question and must keep constraining the search, or "nursing
    // minor" could come back as the nursing major.
    const criteria = parseProgramSearch(query);
    return this.searchWithPrunedTerms(
      criteria.subject,
      'programs',
      `SELECT p.name AS text FROM rockygpt_v2.programs p WHERE p.dataset_version_id = $1::uuid`,
      (subject) => this.findProgramsMatching(criteria, subject)
    );
  }

  private async findProgramsMatching(
    criteria: ReturnType<typeof parseProgramSearch>,
    subject: string
  ): Promise<ProgramRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT p.name, p.degree, p.program_kind, p.school, p.description, p.program_url,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              p.collected_at::text
       FROM rockygpt_v2.programs p JOIN rockygpt_v2.sources s ON s.id = p.source_id
       WHERE p.dataset_version_id = $1::uuid
         AND ($2::text = '' OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $2))
         AND ($3::text = '' OR
           coalesce(
             p.program_kind,
             CASE
               WHEN p.name ~* '\\m4\\s*\\+\\s*1\\M' THEN 'special'
               WHEN coalesce(p.degree, p.name) ~* 'certificate' THEN 'certificate'
               WHEN coalesce(p.degree, p.name) ~* '\\mminor\\M' THEN 'minor'
               WHEN p.name ~* 'undeclared|non-degree' THEN 'undeclared'
               ELSE 'major'
             END
           ) = $3
         )
         AND ($4::text = '' OR lower(coalesce(p.degree, '')) = lower($4))
       ORDER BY
         CASE WHEN $2::text = '' THEN 0 ELSE
           ts_rank(to_tsvector('english', p.name), plainto_tsquery('english', $2))
         END DESC,
         CASE coalesce(
           p.program_kind,
           CASE
             WHEN p.name ~* '\\m4\\s*\\+\\s*1\\M' THEN 'special'
             WHEN coalesce(p.degree, p.name) ~* 'certificate' THEN 'certificate'
             WHEN coalesce(p.degree, p.name) ~* '\\mminor\\M' THEN 'minor'
             WHEN p.name ~* 'undeclared|non-degree' THEN 'undeclared'
             ELSE 'major'
           END
         )
           WHEN 'major' THEN 0
           WHEN 'minor' THEN 1
           WHEN 'certificate' THEN 2
           WHEN 'special' THEN 3
           ELSE 4
         END,
         p.name
       LIMIT 6`,
      [datasetId, subject, criteria.requestedKind || '', criteria.requestedDegree || '']
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      degree: optionalString(row, 'degree'),
      programKind: programKindFromRow(row),
      school: optionalString(row, 'school'),
      description: optionalString(row, 'description'),
      programUrl: optionalString(row, 'program_url'),
      source: sourceFromRow(row),
    }));
  }

  async findContacts(query: string): Promise<ContactRecord[]> {
    return this.searchWithPrunedTerms(
      query,
      'campus_contacts',
      `SELECT c.name || ' ' || coalesce(c.department, '') || ' ' || coalesce(v.terms, '') AS text
         FROM rockygpt_v2.campus_contacts c
         LEFT JOIN (SELECT * FROM unnest($2::text[], $3::text[]) AS t(name, terms)) v
           ON v.name = c.name
        WHERE c.dataset_version_id = $1::uuid`,
      (queryText) => this.findContactsMatching(queryText),
      DOMAIN_WORDS.campus_contacts,
      contactSearchTermArrays()
    );
  }

  async listContacts(): Promise<Array<{ name: string; department?: string }>> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT DISTINCT c.name, c.department
         FROM rockygpt_v2.campus_contacts c
        WHERE c.dataset_version_id = $1::uuid
        ORDER BY c.name`,
      [datasetId]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      department: optionalString(row, 'department'),
    }));
  }

  /** An exact-name fetch, so a resolved contact cannot return a different one. */
  async findContactByName(name: string): Promise<ContactRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT c.name, c.department, c.phone, c.email, c.office,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              c.collected_at::text
         FROM rockygpt_v2.campus_contacts c JOIN rockygpt_v2.sources s ON s.id = c.source_id
        WHERE c.dataset_version_id = $1::uuid AND c.name = $2
        LIMIT 5`,
      [datasetId, name]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      department: optionalString(row, 'department'),
      phone: optionalString(row, 'phone'),
      email: optionalString(row, 'email'),
      office: optionalString(row, 'office'),
      source: sourceFromRow(row),
    }));
  }

  private async findContactsMatching(query: string): Promise<ContactRecord[]> {
    const datasetId = await this.activeDatasetId();
    const vocabulary = contactSearchTermArrays();
    const result = await this.pool.query<Row>(
      `SELECT c.name, c.department, c.phone, c.email, c.office,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              c.collected_at::text
       FROM rockygpt_v2.campus_contacts c
       JOIN rockygpt_v2.sources s ON s.id = c.source_id
       LEFT JOIN (SELECT * FROM unnest($3::text[], $4::text[]) AS t(name, terms)) v
         ON v.name = c.name
       WHERE c.dataset_version_id = $1::uuid
         AND ($2::text = '' OR to_tsvector('english',
               c.name || ' ' || coalesce(c.department, '') || ' ' || coalesce(v.terms, ''))
             @@ plainto_tsquery('english', $2))
       ORDER BY c.name LIMIT 5`,
      [datasetId, query, vocabulary.names, vocabulary.terms]
    );
    return result.rows.map((row) => ({
      name: requiredString(row, 'name'),
      department: optionalString(row, 'department'),
      phone: optionalString(row, 'phone'),
      email: optionalString(row, 'email'),
      office: optionalString(row, 'office'),
      source: sourceFromRow(row),
    }));
  }

  async getShuttleTrips(
    routeHint?: string,
    serviceDay?: ShuttleServiceDay
  ): Promise<ShuttleTripRecord[]> {
    const datasetId = await this.activeDatasetId();
    // Without a route hint the generic Roadrunner timetable answers, matching
    // file-repository behavior; a NULL service_day (datasets published before
    // the additive column) stays eligible for any day.
    const result = await this.pool.query<Row>(
      `SELECT r.name AS route, t.departure, t.arrival, t.stops,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              t.collected_at::text
       FROM rockygpt_v2.shuttle_trips t
       JOIN rockygpt_v2.shuttle_routes r ON r.id = t.route_id
       JOIN rockygpt_v2.sources s ON s.id = t.source_id
       WHERE t.dataset_version_id = $1::uuid
         AND (
           ($2::text <> '' AND lower(r.name) LIKE '%' || lower($2) || '%')
           OR ($2::text = '' AND lower(r.name) LIKE '%roadrunner%')
         )
         AND ($3::text = '' OR r.service_day IS NULL OR r.service_day = $3::text)
       ORDER BY t.sequence LIMIT 50`,
      [datasetId, routeHint || '', serviceDay || '']
    );
    return result.rows.map((row) => ({
      route: requiredString(row, 'route'),
      departure: requiredString(row, 'departure'),
      arrival: requiredString(row, 'arrival'),
      stops: Array.isArray(row.stops)
        ? row.stops.flatMap((stop): Array<{ location: string; time: string }> =>
            stop && typeof stop === 'object'
              ? [{
                  location: requiredString(stop as Row, 'location'),
                  time: requiredString(stop as Row, 'time'),
                }]
              : []
          )
        : [],
      source: sourceFromRow(row),
    }));
  }

  async listShuttleTrips(serviceDay: ShuttleServiceDay): Promise<ShuttleTripRecord[]> {
    const datasetId = await this.activeDatasetId();
    const result = await this.pool.query<Row>(
      `SELECT r.name AS route, t.departure, t.arrival, t.stops,
              s.id::text AS source_id, s.title AS source_title, s.canonical_url AS source_url,
              t.collected_at::text
         FROM rockygpt_v2.shuttle_trips t
         JOIN rockygpt_v2.shuttle_routes r ON r.id = t.route_id
         JOIN rockygpt_v2.sources s ON s.id = t.source_id
        WHERE t.dataset_version_id = $1::uuid
          AND (
            r.service_day = $2::text
            OR (
              r.service_day IS NULL
              AND CASE $2::text
                WHEN 'weekday' THEN lower(r.name) NOT LIKE '%saturday%'
                                  AND lower(r.name) NOT LIKE '%sunday%'
                WHEN 'saturday' THEN lower(r.name) LIKE '%saturday%'
                WHEN 'sunday' THEN lower(r.name) LIKE '%sunday%'
                ELSE false
              END
            )
          )
        ORDER BY t.sequence, r.name`,
      [datasetId, serviceDay]
    );
    return result.rows.map((row) => ({
      route: requiredString(row, 'route'),
      departure: requiredString(row, 'departure'),
      arrival: requiredString(row, 'arrival'),
      stops: Array.isArray(row.stops)
        ? row.stops.flatMap((stop): Array<{ location: string; time: string }> =>
            stop && typeof stop === 'object'
              ? [{
                  location: requiredString(stop as Row, 'location'),
                  time: requiredString(stop as Row, 'time'),
                }]
              : []
          )
        : [],
      source: sourceFromRow(row),
    }));
  }

  async searchDocuments(query: string, options: SearchOptions): Promise<EvidenceItem[]> {
    const datasetId = await this.activeDatasetId();
    // `plainto_tsquery` joins every term with `&`, so a chunk had to contain
    // all of them. Retrieval then got worse the more precise a question was:
    // "guest policy" found the guest policy, "Ramapo overnight guest policy"
    // found nothing, though every one of those words is in the corpus.
    //
    // Matching is OR now — any term qualifies a chunk — and relevance decides
    // the order rather than admission. Three parts to it:
    //
    //   coverage    how much of the question a chunk answers, as a fraction so
    //               a four-word question and a one-word one score on the same
    //               scale. Squared, so covering more of the question beats
    //               mentioning one word of it often.
    //   ts_rank_cd  cover density: rewards query terms appearing near one
    //               another, which is what separates a passage about the
    //               subject from one mentioning it in passing. Length-
    //               normalised (flag 1) so a long page cannot win by length.
    //   trust       a multiplier, never an addend. It was `+0.10` while
    //               relevance sat around 0.03, so an official page about
    //               nothing outranked the right answer. It breaks ties now.
    //
    // Below MIN_RELEVANCE nothing comes back and the caller reports
    // `no_match`, which is a better answer than a passage that happens to
    // share a preposition with the question.
    const sql = `
      WITH q AS (
        SELECT replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery AS loose,
               string_to_array(
                 replace(replace(plainto_tsquery('english', $2)::text, '''', ''), ' & ', ','),
                 ','
               ) AS terms
      ),
      scored AS (
        SELECT c.id::text, d.id::text AS document_id, s.id::text AS source_id,
               coalesce(c.metadata->>'headingPath', d.title) AS title,
               coalesce(c.metadata->>'canonicalUrl', s.canonical_url) AS url,
               c.content, s.domain, s.trust_tier, d.collected_at::text,
               power(
                 (SELECT count(*) FROM unnest(q.terms) AS t
                   WHERE c.lexical_vector @@ plainto_tsquery('english', t))::float
                 / greatest(array_length(q.terms, 1), 1),
                 2
               ) * ts_rank_cd(c.lexical_vector, q.loose, 1) AS relevance,
               CASE s.trust_tier WHEN 'official_primary' THEN 1.05
                                 WHEN 'official_secondary' THEN 1.02 ELSE 1 END AS trust
        FROM rockygpt_v2.document_chunks c
        JOIN rockygpt_v2.documents d ON d.id = c.document_id
        JOIN rockygpt_v2.sources s ON s.id = d.source_id
        CROSS JOIN q
        WHERE d.dataset_version_id = $1::uuid
          AND (cardinality($3::text[]) = 0 OR s.domain = ANY($3::text[]))
          AND c.lexical_vector @@ q.loose
      )
      SELECT id, document_id, source_id, title, url, content, domain, trust_tier,
             collected_at, (relevance * trust) AS score
      FROM scored
      WHERE relevance >= $5
      ORDER BY score DESC, id
      LIMIT $4
    `;
    const values = [datasetId, query, options.domains, options.limit, MIN_RELEVANCE];
    const result = await this.pool.query<Row>(sql, values);
    return result.rows.map((row) => ({
      id: requiredString(row, 'id'),
      documentId: requiredString(row, 'document_id'),
      sourceId: requiredString(row, 'source_id'),
      title: requiredString(row, 'title'),
      url: requiredString(row, 'url'),
      content: requiredString(row, 'content'),
      domain: requiredString(row, 'domain'),
      trustTier: ['official_primary', 'official_secondary', 'community'].includes(requiredString(row, 'trust_tier'))
        ? requiredString(row, 'trust_tier') as EvidenceItem['trustTier']
        : 'unknown',
      collectedAt: requiredDateTime(row, 'collected_at'),
      score: Number(row.score || 0),
    }));
  }
}
