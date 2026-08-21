import fs from 'fs';
import path from 'path';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type Semester, validateAcademicCalendar } from './schema';

interface ContextSemester {
  name: string;
  events: Array<{
    date: string;
    title: string;
    description?: string;
  }>;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'academic');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'calendar.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'calendar.md');

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function parseDateKey(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function toContextSemesters(semesters: Semester[]): ContextSemester[] {
  return sortByName(
    semesters
      .map((semester): ContextSemester | null => {
        const semesterName = normalizeText(semester.name);
        if (!semesterName || !Array.isArray(semester.events)) {
          return null;
        }

        const events = [...semester.events]
          .map((event) => {
            const date = normalizeText(event.date);
            const title = normalizeText(event.title);
            if (!date || !title) return null;
            return {
              date,
              title,
              description: normalizeText(event.description),
            };
          })
          .filter((event): event is NonNullable<typeof event> => event !== null)
          .sort((a, b) => {
            const aDate = parseDateKey(a.date);
            const bDate = parseDateKey(b.date);
            if (aDate !== bDate) return aDate - bDate;
            const dateCmp = a.date.localeCompare(b.date);
            if (dateCmp !== 0) return dateCmp;
            return a.title.localeCompare(b.title);
          });

        if (events.length === 0) return null;
        return { name: semesterName, events };
      })
      .filter((semester): semester is ContextSemester => semester !== null),
    (semester) => semester.name
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let semesters: Semester[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    semesters = validateAcademicCalendar(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating calendar JSON: ${message}`);
    process.exit(1);
  }

  const contextSemesters = toContextSemesters(semesters);
  console.log(`Loaded ${semesters.length} semesters from JSON.`);
  console.log(`Selected ${contextSemesters.length} semesters for context markdown.`);

  let markdown = '# Ramapo College Academic Calendar\n\n';
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  markdown += '---\n\n';

  contextSemesters.forEach((semester) => {
    markdown += `## ${semester.name}\n\n`;
    semester.events.forEach((event) => {
      markdown += `### ${event.date} - ${event.title}\n`;
      if (event.description) {
        markdown += `> ${event.description}\n`;
      }
      markdown += '\n';
    });
    markdown += '---\n\n';
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
