type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return trimmed;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'boolean') {
    return undefined;
  }
  return value;
}

export interface MenuItem {
  formalName: string;
  description?: string;
  calories?: string;
  isVegan?: boolean;
  isVegetarian?: boolean;
  isMindful?: boolean;
  isPlantBased?: boolean;
  allergens?: Array<{ name: string }>;
}

export interface MenuGroup {
  name: string;
  items: MenuItem[];
}

export interface MenuSection {
  name: string;
  groups: MenuGroup[];
}

export interface ArchwayEvent {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  location?: string;
  organizer?: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  tags?: string[];
  attendance?: string;
  ticketStatus?: string;
  offersFreeFood?: boolean;
  foodCategory?: 'food' | 'snacks';
}

function asOptionalFoodCategory(value: unknown): 'food' | 'snacks' | undefined {
  const normalized = asOptionalString(value);
  if (normalized === 'food' || normalized === 'snacks') {
    return normalized;
  }
  return undefined;
}

export interface ArchwayClub {
  name: string;
  category: string;
  bucket?: 'student_orgs' | 'honor_societies' | 'greek_life' | 'athletics' | 'departments' | 'other';
  logoUrl?: string;
  websiteUrl?: string;
  externalWebsiteUrl?: string;
  email?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  twitterUrl?: string;
  linkedinUrl?: string;
  groupmeUrls?: string[];
  groupmeGroups?: Array<{ name: string; url: string }>;
}

export interface LocationHours {
  name: string;
  hours: Record<string, string>;
  notes?: string;
}

export interface CalendarEvent {
  date: string;
  title: string;
  description?: string;
}

export interface Semester {
  name: string;
  events: CalendarEvent[];
}

export interface FacultyProfile {
  name: string;
  title: string;
  school: string;
  email: string;
  phone: string;
  office: string;
  bio: string;
  education: string[];
  courses: string[];
  teachingInterests: string[];
  researchInterests: string[];
  publishedResearch: string[];
  profileUrl: string;
  imageUrl: string;
  imagePath?: string;
}

export interface DiningHoursTime {
  hour: string;
  minute: string;
  period: string;
}

export interface DiningHoursRange {
  allDay: boolean;
  startTime?: DiningHoursTime;
  finishTime?: DiningHoursTime;
  label?: string;
}

export interface DiningHoursGroup {
  days: Array<{ value: string }>;
  hours: DiningHoursRange[];
}

export interface DiningHoursSeason {
  from: string;
  to: string;
  openingHours: DiningHoursGroup[];
}

export interface DiningHoursLocationFragment {
  type: string;
  content: {
    main: {
      name: string;
      slug?: string;
      openingHours: {
        standardHours: DiningHoursGroup[];
        seasonalHours: DiningHoursSeason[];
      };
    };
  };
}

export interface DiningHoursPreloadedState {
  composition: {
    subject: {
      regions: Array<{
        fragments: DiningHoursLocationFragment[];
      }>;
    };
  };
}

function validateMenuItem(input: unknown): MenuItem | null {
  if (!isRecord(input)) {
    return null;
  }

  const formalName = asOptionalString(input.formalName);
  if (!formalName) {
    return null;
  }

  const allergensRaw = Array.isArray(input.allergens) ? input.allergens : [];
  const allergens = allergensRaw
    .map((allergen) => {
      if (!isRecord(allergen)) {
        return null;
      }
      const name = asOptionalString(allergen.name);
      if (!name) {
        return null;
      }
      return { name };
    })
    .filter((allergen): allergen is { name: string } => allergen !== null);

  return {
    formalName,
    description: asOptionalString(input.description),
    calories: asOptionalString(input.calories),
    isVegan: asOptionalBoolean(input.isVegan),
    isVegetarian: asOptionalBoolean(input.isVegetarian),
    isMindful: asOptionalBoolean(input.isMindful),
    isPlantBased: asOptionalBoolean(input.isPlantBased),
    allergens: allergens.length > 0 ? allergens : undefined,
  };
}

export function validateMenuData(input: unknown): MenuSection[] {
  const sectionsRaw = asArray(input, 'menu');
  const sections = sectionsRaw
    .map((section) => {
      if (!isRecord(section)) {
        return null;
      }

      const name = asOptionalString(section.name);
      if (!name) {
        return null;
      }

      const groupsRaw = Array.isArray(section.groups) ? section.groups : [];
      const groups = groupsRaw
        .map((group) => {
          if (!isRecord(group)) {
            return null;
          }
          const itemsRaw = Array.isArray(group.items) ? group.items : [];
          const items = itemsRaw
            .map((item) => validateMenuItem(item))
            .filter((item): item is MenuItem => item !== null);
          if (items.length === 0) {
            return null;
          }
          return {
            name: asOptionalString(group.name) || 'Uncategorized',
            items,
          } satisfies MenuGroup;
        })
        .filter((group): group is MenuGroup => group !== null);

      if (groups.length === 0) {
        return null;
      }

      return {
        name,
        groups,
      } satisfies MenuSection;
    })
    .filter((section): section is MenuSection => section !== null);

  if (sections.length === 0) {
    throw new Error('menu must include at least one valid section with items');
  }

  return sections;
}

export function validateArchwayEvents(input: unknown): ArchwayEvent[] {
  const eventsRaw = asArray(input, 'events');
  const events: ArchwayEvent[] = [];

  eventsRaw.forEach((event) => {
    if (!isRecord(event)) {
      return;
    }

    const title = asOptionalString(event.title);
    const date = asOptionalString(event.date);
    if (!title || !date) {
      return;
    }

    const normalized: ArchwayEvent = { title, date };
    const time = asOptionalString(event.time);
    const endTime = asOptionalString(event.endTime);
    const location = asOptionalString(event.location);
    const organizer = asOptionalString(event.organizer);
    const description = asOptionalString(event.description);
    const url = asOptionalString(event.url);
    const imageUrl = asOptionalString(event.imageUrl);
    const attendance = asOptionalString(event.attendance);
    const ticketStatus = asOptionalString(event.ticketStatus);
    const offersFreeFood = asOptionalBoolean(event.offersFreeFood);
    const foodCategory = asOptionalFoodCategory(event.foodCategory);

    if (time) normalized.time = time;
    if (endTime) normalized.endTime = endTime;
    if (location) normalized.location = location;
    if (organizer) normalized.organizer = organizer;
    if (description) normalized.description = description;
    if (url) normalized.url = url;
    if (imageUrl) normalized.imageUrl = imageUrl;
    if (attendance) normalized.attendance = attendance;
    if (ticketStatus) normalized.ticketStatus = ticketStatus;
    if (offersFreeFood !== undefined) normalized.offersFreeFood = offersFreeFood;
    if (foodCategory) normalized.foodCategory = foodCategory;

    if (Array.isArray(event.tags)) {
      const tags = event.tags
        .map((tag) => asOptionalString(tag))
        .filter((tag): tag is string => Boolean(tag));
      if (tags.length > 0) {
        normalized.tags = tags;
      }
    }

    events.push(normalized);
  });

  if (events.length === 0) {
    throw new Error('events must include at least one valid event');
  }

  return events;
}

export function validateArchwayClubs(input: unknown): ArchwayClub[] {
  const clubsRaw = asArray(input, 'clubs');
  const clubs: ArchwayClub[] = [];

  clubsRaw.forEach((club) => {
    if (!isRecord(club)) {
      return;
    }
    const name = asOptionalString(club.name);
    if (!name) {
      return;
    }

    const normalized: ArchwayClub = {
      name,
      category: asOptionalString(club.category) || 'Other',
    };

    const bucketRaw = asOptionalString((club as UnknownRecord).bucket);
    if (
      bucketRaw &&
      ['student_orgs', 'honor_societies', 'greek_life', 'athletics', 'departments', 'other'].includes(bucketRaw)
    ) {
      normalized.bucket = bucketRaw as ArchwayClub['bucket'];
    }

    const logoUrl = asOptionalString(club.logoUrl);
    const websiteUrl = asOptionalString(club.websiteUrl);
    const externalWebsiteUrl = asOptionalString((club as UnknownRecord).externalWebsiteUrl);
    const email = asOptionalString(club.email);
    const instagramUrl = asOptionalString(club.instagramUrl);
    const facebookUrl = asOptionalString((club as UnknownRecord).facebookUrl);
    const twitterUrl = asOptionalString((club as UnknownRecord).twitterUrl);
    const linkedinUrl = asOptionalString((club as UnknownRecord).linkedinUrl);
    const groupmeUrlsRaw = Array.isArray(club.groupmeUrls) ? club.groupmeUrls : [];
    const groupmeUrls = Array.from(
      new Set(
        groupmeUrlsRaw
          .map((url) => asOptionalString(url))
          .filter((url): url is string => Boolean(url))
      )
    );
    const groupmeGroupsRaw = Array.isArray((club as UnknownRecord).groupmeGroups)
      ? ((club as UnknownRecord).groupmeGroups as unknown[])
      : [];
    const groupmeGroups = groupmeGroupsRaw
      .map((group, idx) => {
        if (!isRecord(group)) return null;
        const url = asOptionalString(group.url);
        if (!url) return null;
        const name = asOptionalString(group.name) || `GroupMe ${idx + 1}`;
        return { name, url };
      })
      .filter((group): group is { name: string; url: string } => group !== null);
    if (logoUrl) normalized.logoUrl = logoUrl;
    if (websiteUrl) normalized.websiteUrl = websiteUrl;
    if (externalWebsiteUrl) normalized.externalWebsiteUrl = externalWebsiteUrl;
    if (email) normalized.email = email;
    if (instagramUrl) normalized.instagramUrl = instagramUrl;
    if (facebookUrl) normalized.facebookUrl = facebookUrl;
    if (twitterUrl) normalized.twitterUrl = twitterUrl;
    if (linkedinUrl) normalized.linkedinUrl = linkedinUrl;
    if (groupmeUrls.length > 0) normalized.groupmeUrls = groupmeUrls;
    if (groupmeGroups.length > 0) normalized.groupmeGroups = groupmeGroups;

    clubs.push(normalized);
  });

  if (clubs.length === 0) {
    throw new Error('clubs must include at least one valid club');
  }

  return clubs;
}

export function validateCampusHours(input: unknown): LocationHours[] {
  const locationsRaw = asArray(input, 'hours');
  const locations: LocationHours[] = [];

  locationsRaw.forEach((location) => {
    if (!isRecord(location)) {
      return;
    }
    const name = asOptionalString(location.name);
    if (!name || !isRecord(location.hours)) {
      return;
    }

    const hours: Record<string, string> = {};
    Object.entries(location.hours).forEach(([day, value]) => {
      const dayName = asOptionalString(day);
      const hoursValue = asOptionalString(value);
      if (dayName && hoursValue) {
        hours[dayName] = hoursValue;
      }
    });

    if (Object.keys(hours).length === 0) {
      return;
    }

    const normalized: LocationHours = { name, hours };
    const notes = asOptionalString(location.notes);
    if (notes) normalized.notes = notes;
    locations.push(normalized);
  });

  if (locations.length === 0) {
    throw new Error('hours must include at least one valid location');
  }

  return locations;
}

export function validateAcademicCalendar(input: unknown): Semester[] {
  const semestersRaw = asArray(input, 'calendar');
  const semesters: Semester[] = [];

  semestersRaw.forEach((semester) => {
    if (!isRecord(semester)) {
      return;
    }
    const name = asOptionalString(semester.name);
    if (!name) {
      return;
    }

    const eventsRaw = Array.isArray(semester.events) ? semester.events : [];
    const events: CalendarEvent[] = [];
    eventsRaw.forEach((event) => {
      if (!isRecord(event)) {
        return;
      }
      const date = asOptionalString(event.date);
      const title = asOptionalString(event.title);
      if (!date || !title) {
        return;
      }
      const normalized: CalendarEvent = { date, title };
      const description = asOptionalString(event.description);
      if (description) normalized.description = description;
      events.push(normalized);
    });

    if (events.length === 0) {
      return;
    }

    semesters.push({ name, events });
  });

  if (semesters.length === 0) {
    throw new Error('calendar must include at least one valid semester');
  }

  return semesters;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asOptionalString(item))
    .filter((item): item is string => Boolean(item));
}

function sanitizeProfileText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function asCleanString(value: unknown): string {
  const text = asOptionalString(value);
  return text ? sanitizeProfileText(text) : '';
}

function asCleanStringArray(value: unknown): string[] {
  return asStringArray(value).map(sanitizeProfileText).filter(Boolean);
}

const FACULTY_BOILERPLATE_PATTERNS = [
  /Ramapo College of New Jersey recognizes the value of publishing on the Internet\.?/gi,
  /The College does not preview,\s*review,\s*censor,\s*or control the content of these pages in any way as a matter of course\.?/gi,
  /This page and Web pages linked from this page are created by the authors,\s*and do not in any way constitute official Ramapo College of New Jersey content\.?/gi,
] as const;

function normalizeFacultyIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}@.+:/?=&_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanFacultyTitle(value: unknown): string {
  const raw = asCleanString(value)
    .replace(/([a-z)])(Liaison\s*:)/g, '$1 $2')
    .replace(
      /(?<=[a-z)])[A-Z]{1,8}-\d+[A-Z]?\s*[Ee]xt(?:ension)?\s*:?\s*\d+(?:\s*\|\s*[Ee]-?[Mm]ail\s*:.*)?$/,
      ''
    )
    .replace(
      /\s+[A-Z]{1,8}-\d+[A-Z]?\s*[Ee]xt(?:ension)?\s*:?\s*\d+(?:\s*\|\s*[Ee]-?[Mm]ail\s*:.*)?$/,
      ''
    )
    .replace(/\s*\|\s*E-?mail\s*:.*$/i, '')
    .replace(/\s+E-?mail\s*:.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw;
}

function removeFacultyBoilerplate(value: string): string {
  let cleaned = value;
  for (const pattern of FACULTY_BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanFacultyResearch(value: unknown): string[] {
  return asCleanStringArray(value).filter((entry) => {
    if (/^more about\s+/i.test(entry)) return false;
    return !FACULTY_BOILERPLATE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(entry);
    });
  });
}

function canonicalFacultyProfileUrl(value: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.startsWith('utm_') || key === 'rel') parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return normalizeFacultyIdentity(value);
  }
}

function facultyProfileIdentity(profile: FacultyProfile): string {
  const name = normalizeFacultyIdentity(profile.name);
  const title = normalizeFacultyIdentity(profile.title);
  const school = normalizeFacultyIdentity(profile.school);
  const profileUrl = canonicalFacultyProfileUrl(profile.profileUrl);
  const email = normalizeFacultyIdentity(profile.email);

  if (profileUrl) {
    return `profile:${name}|${profileUrl}`;
  }
  if (email) {
    return `email:${name}|${email}`;
  }
  return `fallback:${name}|${title}|${school}|${normalizeFacultyIdentity(profile.office)}`;
}

function preferNonEmpty(primary: string, secondary: string): string {
  return primary || secondary;
}

function preferRicherText(primary: string, secondary: string): string {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return secondary.length > primary.length ? secondary : primary;
}

function mergeFacultyLists(primary: string[], secondary: string[]): string[] {
  const merged = new Map<string, string>();
  for (const entry of [...primary, ...secondary]) {
    const key = normalizeFacultyIdentity(entry);
    if (key && !merged.has(key)) merged.set(key, entry);
  }
  return Array.from(merged.values());
}

function mergeFacultyProfiles(primary: FacultyProfile, secondary: FacultyProfile): FacultyProfile {
  const merged: FacultyProfile = {
    name: preferRicherText(primary.name, secondary.name),
    title: preferRicherText(primary.title, secondary.title),
    school: preferRicherText(primary.school, secondary.school),
    email: preferNonEmpty(primary.email, secondary.email),
    phone: preferNonEmpty(primary.phone, secondary.phone),
    office: preferNonEmpty(primary.office, secondary.office),
    bio: preferRicherText(primary.bio, secondary.bio),
    education: mergeFacultyLists(primary.education, secondary.education),
    courses: mergeFacultyLists(primary.courses, secondary.courses),
    teachingInterests: mergeFacultyLists(
      primary.teachingInterests,
      secondary.teachingInterests
    ),
    researchInterests: mergeFacultyLists(
      primary.researchInterests,
      secondary.researchInterests
    ),
    publishedResearch: mergeFacultyLists(
      primary.publishedResearch,
      secondary.publishedResearch
    ),
    profileUrl: preferNonEmpty(primary.profileUrl, secondary.profileUrl),
    imageUrl: preferNonEmpty(primary.imageUrl, secondary.imageUrl),
  };
  const imagePath = primary.imagePath || secondary.imagePath;
  if (imagePath) merged.imagePath = imagePath;
  return merged;
}

export function validateFacultyProfiles(input: unknown): FacultyProfile[] {
  const profilesRaw = asArray(input, 'faculty');
  const profiles: FacultyProfile[] = [];
  const identityIndexes = new Map<string, number>();

  profilesRaw.forEach((profile) => {
    if (!isRecord(profile)) {
      return;
    }

    const name = asOptionalString(profile.name);
    const title = cleanFacultyTitle(profile.title);
    const school = asOptionalString(profile.school);
    if (!name || !title || !school) {
      return;
    }

    const normalized: FacultyProfile = {
      name,
      title,
      school,
      email: asOptionalString(profile.email) || '',
      phone: asOptionalString(profile.phone) || '',
      office: asOptionalString(profile.office) || '',
      bio: removeFacultyBoilerplate(asCleanString(profile.bio)),
      education: asCleanStringArray(profile.education),
      courses: asCleanStringArray(profile.courses),
      teachingInterests: asCleanStringArray(profile.teachingInterests),
      researchInterests: asCleanStringArray(profile.researchInterests),
      publishedResearch: cleanFacultyResearch(profile.publishedResearch),
      profileUrl: asOptionalString(profile.profileUrl) || '',
      imageUrl: asOptionalString(profile.imageUrl) || '',
    };

    const imagePath = asOptionalString(profile.imagePath);
    if (imagePath) {
      normalized.imagePath = imagePath;
    }

    const identity = facultyProfileIdentity(normalized);
    const existingIndex = identityIndexes.get(identity);
    if (existingIndex === undefined) {
      identityIndexes.set(identity, profiles.length);
      profiles.push(normalized);
    } else {
      profiles[existingIndex] = mergeFacultyProfiles(profiles[existingIndex], normalized);
    }
  });

  if (profiles.length === 0) {
    throw new Error('faculty must include at least one valid profile');
  }

  return profiles;
}

function validateDiningTime(input: unknown): DiningHoursTime | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const hour = asOptionalString(input.hour);
  const minute = asOptionalString(input.minute);
  const period = asOptionalString(input.period);
  if (!hour || !minute || !period) {
    return undefined;
  }
  return { hour, minute, period };
}

function parseAllDayBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === 'closed';
  }
  if (isRecord(value)) {
    const val = asOptionalString(value.value);
    if (val) {
      const lower = val.trim().toLowerCase();
      return lower === 'true' || lower === 'closed';
    }
  }
  return false;
}

function validateDiningHoursRange(input: unknown): DiningHoursRange | null {
  if (!isRecord(input)) {
    return null;
  }

  const allDay = parseAllDayBoolean(input.allDay);

  return {
    allDay,
    startTime: validateDiningTime(input.startTime),
    finishTime: validateDiningTime(input.finishTime),
    label: asOptionalString(input.label),
  };
}

function validateDiningHoursGroup(input: unknown): DiningHoursGroup | null {
  if (!isRecord(input)) {
    return null;
  }

  const daysRaw = Array.isArray(input.days) ? input.days : [];
  const days = daysRaw
    .map((day) => {
      if (typeof day === 'string') {
        const trimmed = day.trim();
        return trimmed ? { value: trimmed } : null;
      }
      if (isRecord(day)) {
        const value = asOptionalString(day.value);
        if (value) {
          return { value };
        }
      }
      return null;
    })
    .filter((day): day is { value: string } => day !== null);

  const hoursRaw = Array.isArray(input.hours) ? input.hours : [];
  const hours = hoursRaw
    .map((range) => validateDiningHoursRange(range))
    .filter((range): range is DiningHoursRange => range !== null);

  if (days.length === 0 || hours.length === 0) {
    return null;
  }

  return {
    days,
    hours,
  };
}

function validateDiningSeason(input: unknown): DiningHoursSeason | null {
  if (!isRecord(input)) {
    return null;
  }

  const from = asOptionalString(input.from);
  const to = asOptionalString(input.to);
  if (!from || !to) {
    return null;
  }

  const groupsRaw = Array.isArray(input.openingHours) ? input.openingHours : [];
  const openingHours = groupsRaw
    .map((group) => validateDiningHoursGroup(group))
    .filter((group): group is DiningHoursGroup => group !== null);

  return {
    from,
    to,
    openingHours,
  };
}

export function validateDiningHoursState(input: unknown): DiningHoursPreloadedState {
  const root = asRecord(input, 'diningHoursState');
  const composition = asRecord(root.composition, 'diningHoursState.composition');
  const subject = asRecord(composition.subject, 'diningHoursState.composition.subject');
  const regionsRaw = asArray(subject.regions, 'diningHoursState.composition.subject.regions');

  const regions = regionsRaw.map((region, regionIndex) => {
    const regionRecord = asRecord(
      region,
      `diningHoursState.composition.subject.regions[${regionIndex}]`
    );
    const fragmentsRaw = Array.isArray(regionRecord.fragments) ? regionRecord.fragments : [];

    const fragments: DiningHoursLocationFragment[] = [];
    fragmentsRaw.forEach((fragment, fragmentIndex) => {
      if (!isRecord(fragment)) {
        return;
      }
      const type = asOptionalString(fragment.type);
      if (!type || type !== 'Location') {
        return;
      }

      const content = asRecord(
        fragment.content,
        `region[${regionIndex}].fragments[${fragmentIndex}].content`
      );
      const main = asRecord(
        content.main,
        `region[${regionIndex}].fragments[${fragmentIndex}].content.main`
      );
      const name = asString(
        main.name,
        `region[${regionIndex}].fragments[${fragmentIndex}].content.main.name`
      );
      const openingHoursRecord = asRecord(
        main.openingHours,
        `region[${regionIndex}].fragments[${fragmentIndex}].content.main.openingHours`
      );

      const standardHoursRaw = Array.isArray(openingHoursRecord.standardHours)
        ? openingHoursRecord.standardHours
        : [];
      const seasonalHoursRaw = Array.isArray(openingHoursRecord.seasonalHours)
        ? openingHoursRecord.seasonalHours
        : [];

      const standardHours = standardHoursRaw
        .map((group) => validateDiningHoursGroup(group))
        .filter((group): group is DiningHoursGroup => group !== null);

      const seasonalHours = seasonalHoursRaw
        .map((season) => validateDiningSeason(season))
        .filter((season): season is DiningHoursSeason => season !== null);

      const normalized: DiningHoursLocationFragment = {
        type: 'Location',
        content: {
          main: {
            name,
            openingHours: {
              standardHours,
              seasonalHours,
            },
          },
        },
      };

      const slug = asOptionalString(main.slug);
      if (slug) {
        normalized.content.main.slug = slug;
      }

      fragments.push(normalized);
    });

    return { fragments };
  });

  const locationCount = regions.reduce((acc, region) => acc + region.fragments.length, 0);
  if (locationCount === 0) {
    throw new Error('dining hours must include at least one location fragment');
  }

  return {
    composition: {
      subject: {
        regions,
      },
    },
  };
}

export function countDiningLocations(state: DiningHoursPreloadedState): number {
  return state.composition.subject.regions.reduce(
    (count, region) => count + region.fragments.length,
    0
  );
}
