import { parseEventStart } from './event-time';

export type CalendarFamily =
  | 'application'
  | 'break'
  | 'finals'
  | 'grades'
  | 'grading'
  | 'graduation'
  | 'holiday'
  | 'instruction'
  | 'other'
  | 'registration'
  | 'tuition'
  | 'withdrawal';

export type CalendarKind =
  | 'add_drop_deadline'
  | 'application_deadline'
  | 'break'
  | 'classes_begin'
  | 'classes_end'
  | 'conferral'
  | 'finals'
  | 'grades_due'
  | 'grading_option_deadline'
  | 'holiday'
  | 'independent_study_registration_deadline'
  | 'other'
  | 'tuition_refund_deadline'
  | 'withdrawal_deadline';

export const CALENDAR_FAMILIES: ReadonlySet<CalendarFamily> = new Set([
  'application',
  'break',
  'finals',
  'grades',
  'grading',
  'graduation',
  'holiday',
  'instruction',
  'other',
  'registration',
  'tuition',
  'withdrawal',
]);

export const CALENDAR_KINDS: ReadonlySet<CalendarKind> = new Set([
  'add_drop_deadline',
  'application_deadline',
  'break',
  'classes_begin',
  'classes_end',
  'conferral',
  'finals',
  'grades_due',
  'grading_option_deadline',
  'holiday',
  'independent_study_registration_deadline',
  'other',
  'tuition_refund_deadline',
  'withdrawal_deadline',
]);

export interface CalendarConcept {
  family: CalendarFamily;
  kind: CalendarKind;
  termId: string;
  session?: string;
  sessionId?: string;
  startsAt?: string;
}

interface CalendarEventLike {
  date: string;
  title: string;
  description?: string;
}

const SESSION_NUMBER = '(I|II|III|IV)';

export function calendarEntityId(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sessionFrom(title: string): Pick<CalendarConcept, 'session' | 'sessionId'> {
  const mixed = new RegExp(
    `\\bfull(?: semester| session| summer)?\\b.*\\b(?:mini |summer )?session ${SESSION_NUMBER}\\b|` +
      `\\bfull and (?:mini |summer )?session ${SESSION_NUMBER}\\b`,
    'i'
  );
  if (mixed.test(title)) return {};

  const mini = new RegExp(`\\bmini(?: session)? ${SESSION_NUMBER}\\b`, 'i').exec(title);
  if (mini) {
    const number = mini[1].toUpperCase();
    return { session: `Mini Session ${number}`, sessionId: `mini-session-${number.toLowerCase()}` };
  }

  if (/\bfull (?:semester|session|summer)\b/i.test(title)) {
    return { session: 'Full Semester', sessionId: 'full-semester' };
  }

  const numbered = new RegExp(
    `\\b(?:session|summer(?: session)?) ${SESSION_NUMBER}\\b`,
    'i'
  ).exec(title);
  if (numbered) {
    const number = numbered[1].toUpperCase();
    return { session: `Session ${number}`, sessionId: `session-${number.toLowerCase()}` };
  }
  return {};
}

function conceptFrom(title: string): Pick<CalendarConcept, 'family' | 'kind'> {
  if (/\badd\s*\/\s*drop\b|\badd and drop\b/i.test(title)) {
    return { family: 'registration', kind: 'add_drop_deadline' };
  }
  if (/\blast day to register\b|\bregistration (?:ends?|deadline)\b/i.test(title)) {
    return { family: 'registration', kind: 'independent_study_registration_deadline' };
  }
  if (/\bwithdraw(?:al)?\b/i.test(title)) {
    return { family: 'withdrawal', kind: 'withdrawal_deadline' };
  }
  if (/\brefund\b/i.test(title)) {
    return { family: 'tuition', kind: 'tuition_refund_deadline' };
  }
  if (/\bpass\s*\/\s*fail\b|\baudit grade\b|\bincomplete\b|\bI grade\b/i.test(title)) {
    return { family: 'grading', kind: 'grading_option_deadline' };
  }
  if (/\bclasses? begin\b|\bfirst day of classes\b/i.test(title)) {
    return { family: 'instruction', kind: 'classes_begin' };
  }
  if (/\blast day of (?:classes|the session)\b|\bclasses end\b/i.test(title)) {
    return { family: 'instruction', kind: 'classes_end' };
  }
  if (/\bfinal(?:s| examinations?| exams?)\b/i.test(title)) {
    return { family: 'finals', kind: 'finals' };
  }
  if (/\bbreak\b/i.test(title)) return { family: 'break', kind: 'break' };
  if (/\bholiday\b|\bcollege closed\b|\bno classes\b/i.test(title)) {
    return { family: 'holiday', kind: 'holiday' };
  }
  if (/\bgrades? due\b/i.test(title)) return { family: 'grades', kind: 'grades_due' };
  if (/\bapplication(?:s)? due\b|\bapplication deadline\b/i.test(title)) {
    return { family: 'application', kind: 'application_deadline' };
  }
  if (/\bgraduation\b|\bconferral\b/i.test(title)) {
    return { family: 'graduation', kind: 'conferral' };
  }
  return { family: 'other', kind: 'other' };
}

function startsAt(term: string, event: CalendarEventLike): string | undefined {
  const year = /\b(20\d{2})\b/.exec(term)?.[1];
  if (!year) return undefined;
  const parsed = parseEventStart(`${event.date}, ${year}`, event.description || '12:00 AM');
  return parsed.ok ? parsed.startsAtIso : undefined;
}

/** Adds stable domain metadata without replacing source-facing labels. */
export function calendarConcept(term: string, event: CalendarEventLike): CalendarConcept {
  const instant = startsAt(term, event);
  return {
    ...conceptFrom(event.title),
    termId: calendarEntityId(term),
    ...sessionFrom(event.title),
    ...(instant ? { startsAt: instant } : {}),
  };
}

export function calendarWithConcepts<
  Event extends CalendarEventLike,
  Term extends { name: string; events: Event[] },
>(semesters: Term[]): Array<Omit<Term, 'events'> & { events: Array<Event & CalendarConcept> }> {
  return semesters.map((semester) => ({
    ...semester,
    events: semester.events.map((event) => ({
      ...event,
      ...calendarConcept(semester.name, event),
    })),
  }));
}
