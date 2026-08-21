/**
 * Calendar-modal date semantics (PROB-019). An important-dates entry like
 * "Jan. 19" carries no year; the year belongs to the semester whose tab is
 * displayed. Housing and academic semesters can carry different years, so
 * chronology (past styling, the "Up Next" marker, auto-scroll) must derive
 * the year from the selected tab's semester name — never from the other
 * mode's default.
 */
export function parseSemesterEventDate(dateStr: string, semesterName: string): Date {
  const yearMatch = semesterName.match(/\d{4}/);
  const year = yearMatch ? yearMatch[0] : new Date().getFullYear();

  // Extract just the month abbreviation and the digits: e.g. "May 26" or "May. 26"
  const dateParts = dateStr.trim().split(' ');
  const rawMonth = dateParts[0]?.replace(/[^a-zA-Z]/g, '') || '';
  const monthStr = rawMonth.substring(0, 3); // "Jan", "Feb", "May"
  const dayStr = dateParts[1]?.replace(/[^0-9]/g, '') || '1';

  const parsed = new Date(`${monthStr} ${dayStr}, ${year}`);
  // If parsing fails, fall back to the far future so an unreadable date is
  // never presented as already past.
  return isNaN(parsed.getTime()) ? new Date(9999, 0, 1) : parsed;
}
