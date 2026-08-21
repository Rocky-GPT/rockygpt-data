import type {
  CriticalFactRecord,
  DatasetContext,
  EvidenceItem,
} from '../types';
import type {
  AcademicDateRecord,
  ClubRecord,
  ContactRecord,
  DiningVenueRecord,
  EventRecord,
  HoursRecord,
  MenuItemRecord,
  ProgramRecord,
  ShuttleServiceDay,
  ShuttleTripRecord,
} from '../schemas';

export interface SearchOptions {
  domain: string;
  limit: number;
}

export interface RockyRepositoryV2 {
  getDatasetContext(): Promise<DatasetContext>;
  /**
   * A view whose reads are all scoped to one immutable dataset (PROB-013).
   * The orchestrator resolves the active dataset once per request and pins
   * it, so an activation during the request cannot mix versions.
   */
  withDataset(dataset: DatasetContext): RockyRepositoryV2;
  getCriticalFact(key: string): Promise<CriticalFactRecord | null>;
  /** Canonical dining entities from the pinned structured dataset. */
  listDiningVenues(): Promise<DiningVenueRecord[]>;
  findMenuItems(query: string, meal?: string): Promise<MenuItemRecord[]>;
  /**
   * `at` resolves seasonal overrides for that instant (PROB-010); without it
   * only the standard weekly schedule is visible (used by publication).
   */
  findDiningHours(query: string, day: string, at?: Date): Promise<HoursRecord[]>;
  findCampusHours(query: string, day: string, at?: Date): Promise<HoursRecord[]>;
  /**
   * Every venue name in the dataset, which is the closed set a question can be
   * resolved against instead of matching words against words.
   */
  listCampusHourVenues(): Promise<string[]>;
  /**
   * Hours for one named venue, matched exactly rather than by overlapping
   * words. Once a question has resolved to a venue, the lookup is a fetch and
   * cannot return a different building.
   */
  findCampusHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]>;
  findDiningHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]>;
  /** Every contact name and department, the closed set for directory lookups. */
  listContacts(): Promise<Array<{ name: string; department?: string }>>;
  /** One contact, matched exactly rather than by overlapping words. */
  findContactByName(name: string): Promise<ContactRecord[]>;
  findAcademicDates(query: string): Promise<AcademicDateRecord[]>;
  findEvents(query: string, now: Date): Promise<EventRecord[]>;
  findClubs(query: string): Promise<ClubRecord[]>;
  findPrograms(query: string): Promise<ProgramRecord[]>;
  findContacts(query: string): Promise<ContactRecord[]>;
  getShuttleTrips(
    routeHint?: string,
    serviceDay?: ShuttleServiceDay
  ): Promise<ShuttleTripRecord[]>;
  searchDocuments(query: string, options: SearchOptions): Promise<EvidenceItem[]>;
}
