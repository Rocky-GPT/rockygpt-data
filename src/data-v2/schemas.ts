import type { SourceReference } from './types';

export interface MenuItemRecord {
  meal: string;
  station: string;
  name: string;
  calories?: string;
  vegan: boolean;
  vegetarian: boolean;
  allergens: string[];
  source: SourceReference;
}

export interface DiningVenueRecord {
  /** Stable dataset-derived identifier used only after entity resolution. */
  id: string;
  name: string;
  capabilities: Array<'hours' | 'menu'>;
}

export interface HoursRecord {
  name: string;
  day: string;
  schedule: string;
  source: SourceReference;
}

export interface EventRecord {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  organizer?: string;
  description?: string;
  eventUrl?: string;
  source: SourceReference;
}

export interface ClubRecord {
  name: string;
  category?: string;
  websiteUrl?: string;
  source: SourceReference;
}

export interface ProgramRecord {
  name: string;
  degree?: string;
  programKind?: 'major' | 'minor' | 'certificate' | 'undeclared' | 'other' | 'special';
  school?: string;
  description?: string;
  programUrl?: string;
  source: SourceReference;
}

export interface ContactRecord {
  name: string;
  department?: string;
  phone?: string;
  email?: string;
  office?: string;
  source: SourceReference;
}

export interface AcademicDateRecord {
  term: string;
  date: string;
  title: string;
  description?: string;
  source: SourceReference;
}

/**
 * The service timetable a shuttle trip belongs to. Weekday covers
 * Monday–Friday; Saturday and Sunday have their own published timetables.
 */
export type ShuttleServiceDay = 'weekday' | 'saturday' | 'sunday';

export interface ShuttleTripRecord {
  route: string;
  departure: string;
  arrival: string;
  stops: Array<{ location: string; time: string }>;
  source: SourceReference;
}
