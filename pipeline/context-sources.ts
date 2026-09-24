import path from 'node:path';

/** The publishable source a generated context document belongs to, by its path. */
export function sourceKeyForPath(filePath: string): string {
  const relative = filePath.split(path.sep).join('/').toLowerCase();
  // First: office documents are named for their folders (clubs, health, eof-program...).
  if (relative.includes('/campus/offices/')) return 'office-pages';
  if (relative.includes('/dining/')) return 'dining';
  if (relative.includes('calendar')) return 'academic-calendar';
  if (relative.includes('major-pages')) return 'major-pages';
  if (relative.includes('major-page-links')) return 'major-page-links';
  if (relative.includes('program') || relative.includes('/courses/')) return 'academic-programs';
  if (relative.includes('faculty')) return 'faculty';
  if (relative.includes('club')) return 'archway-clubs';
  if (relative.includes('event')) return 'archway-events';
  if (relative.includes('transport')) return 'transportation';
  if (relative.includes('directory')) return 'campus-directory';
  if (relative.includes('safety')) return 'public-safety';
  if (relative.includes('housing')) return 'housing';
  if (relative.includes('health')) return 'health';
  if (relative.includes('counsel')) return 'counseling';
  return 'campus-hours';
}
