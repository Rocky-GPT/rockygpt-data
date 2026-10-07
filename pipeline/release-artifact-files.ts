/**
 * Files the publisher saves as release artifacts, keyed by artifact key.
 * Refreshes restore these from the active release, so every entry needs a
 * restore target in RELEASE_ARTIFACT_TARGETS unless the file comes back
 * another way (see restore-active-release.test.ts).
 */
export const RELEASE_ARTIFACT_FILES: Readonly<Record<string, string>> = {
  'search-vocabulary': 'src/reference/search-vocabulary.json',
  'office-contact-review': 'src/reference/office-contact-review.json',
  'office-hours-review': 'src/reference/office-hours-review.json',
  calendar: 'public/data/calendar.json',
  clubs: 'public/data/clubs.json',
  courses: 'public/data/courses.json',
  events: 'public/data/events.json',
  hours: 'public/data/hours.json',
  'hours-omissions': 'data/normalized/hours-omissions.json',
  programs: 'public/data/programs.json',
  'graduation-plans': 'public/data/graduation-plans.json',
  'major-pages': 'public/data/major-pages.json',
  menu: 'data/normalized/menu.json',
  'menu-week': 'data/normalized/menu-week.json',
  'menu-context': 'data/context/dining/menu.md',
  'dining-hours': 'data/normalized/dining-hours.json',
  faculty: 'data/normalized/faculty.json',
  transportation: 'data/context/campus/transportation.md',
  'dining-hours-context': 'data/context/dining/hours.md',
};
