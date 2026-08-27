import fs from 'node:fs';
import path from 'node:path';

import { validateAcademicCalendar } from '../ingestion/schema';
import { writeJsonFile } from '../ingestion/pipeline-utils';
import { calendarWithConcepts } from '../src/data-v2/calendar-concepts';

const targets = [
  path.join(process.cwd(), 'data', 'normalized', 'calendar.json'),
  path.join(process.cwd(), 'public', 'data', 'calendar.json'),
];

for (const target of targets) {
  if (!fs.existsSync(target)) continue;
  const calendar = validateAcademicCalendar(JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
  writeJsonFile(target, calendarWithConcepts(calendar));
  console.log(`Added canonical calendar concepts to ${target}`);
}
