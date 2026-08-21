/**
 * The publishable source catalog: one seed per official source, including its
 * freshness SLA. Shared by the publisher and the quality gates so provenance
 * evaluation and publication always describe the same sources.
 */
export interface SourceSeed {
  key: string;
  title: string;
  url: string;
  trustTier: 'official_primary' | 'official_secondary' | 'community';
  freshnessHours: number;
  domain: string;
}

export const SOURCES: SourceSeed[] = [
  { key: 'public-safety', title: 'Public Safety', url: 'https://www.ramapo.edu/publicsafety/', trustTier: 'official_primary', freshnessHours: 168, domain: 'safety' },
  { key: 'password-reset', title: 'Password Reset', url: 'https://password.ramapo.edu/', trustTier: 'official_primary', freshnessHours: 720, domain: 'technology' },
  { key: 'information-technology-services', title: 'Information Technology Services', url: 'https://www.ramapo.edu/its/', trustTier: 'official_primary', freshnessHours: 720, domain: 'technology' },
  { key: 'tuition-costs', title: 'Tuition & Costs', url: 'https://www.ramapo.edu/admissions/financial-aid-tuition/tuition-costs/', trustTier: 'official_primary', freshnessHours: 720, domain: 'financial_aid' },
  { key: 'academic-calendar', title: 'Academic Calendar', url: 'https://www.ramapo.edu/academic-calendars/', trustTier: 'official_primary', freshnessHours: 168, domain: 'calendar' },
  { key: 'dining', title: 'Ramapo Dining', url: 'https://ramapo.sodexomyway.com/', trustTier: 'official_primary', freshnessHours: 24, domain: 'dining' },
  { key: 'campus-hours', title: 'Campus Hours', url: 'https://www.ramapo.edu/about/campus-hours/', trustTier: 'official_primary', freshnessHours: 4_320, domain: 'hours' },
  { key: 'archway-events', title: 'Archway Events', url: 'https://archway.ramapo.edu/events', trustTier: 'official_primary', freshnessHours: 24, domain: 'events' },
  { key: 'archway-clubs', title: 'Archway Student Organizations', url: 'https://archway.ramapo.edu/club_signup?view=all&', trustTier: 'official_primary', freshnessHours: 4_320, domain: 'clubs' },
  { key: 'academic-programs', title: 'Ramapo Programs', url: 'https://www.ramapo.edu/majors-minors/', trustTier: 'official_primary', freshnessHours: 4_320, domain: 'programs' },
  { key: 'campus-directory', title: 'Campus Directory', url: 'https://www.ramapo.edu/campus-directory/', trustTier: 'official_primary', freshnessHours: 168, domain: 'directory' },
  { key: 'transportation', title: 'Transportation Services', url: 'https://www.ramapo.edu/about/transportation-services/ramapo-roadrunner-express-shuttle/', trustTier: 'official_primary', freshnessHours: 168, domain: 'transportation' },
  { key: 'housing', title: 'Residence Life', url: 'https://www.ramapo.edu/reslife/', trustTier: 'official_primary', freshnessHours: 168, domain: 'housing' },
  { key: 'health', title: 'Health Services', url: 'https://www.ramapo.edu/health/', trustTier: 'official_primary', freshnessHours: 168, domain: 'health' },
  { key: 'counseling', title: 'Counseling Services', url: 'https://www.ramapo.edu/counseling/', trustTier: 'official_primary', freshnessHours: 168, domain: 'counseling' },
  { key: 'faculty', title: 'Faculty Profiles', url: 'https://www.ramapo.edu/academics/faculty/', trustTier: 'official_secondary', freshnessHours: 720, domain: 'directory' },
];
