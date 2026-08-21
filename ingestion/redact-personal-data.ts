import fs from 'fs';
import path from 'path';

const TARGET_DIRS = [
  path.join(process.cwd(), 'data', 'raw'),
  path.join(process.cwd(), 'data', 'normalized'),
];

const STRING_FIELD_KEYS = new Set([
  'email',
  'phone',
  'office',
  'profileUrl',
  'imageUrl',
  'imagePath',
]);

const ARRAY_CLEAR_KEYS = new Set(['contacts']);

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;

interface Stats {
  files: number;
  stringFieldsRedacted: number;
  contactArraysCleared: number;
  stringPatternRedactions: number;
}

function redactString(input: string, stats: Stats): string {
  let output = input;

  const emailMatches = output.match(EMAIL_PATTERN);
  if (emailMatches && emailMatches.length > 0) {
    stats.stringPatternRedactions += emailMatches.length;
    output = output.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
  }

  const phoneMatches = output.match(PHONE_PATTERN);
  if (phoneMatches && phoneMatches.length > 0) {
    stats.stringPatternRedactions += phoneMatches.length;
    output = output.replace(PHONE_PATTERN, '[REDACTED_PHONE]');
  }

  if (output.toLowerCase().startsWith('mailto:')) {
    stats.stringPatternRedactions += 1;
    output = 'mailto:[REDACTED_EMAIL]';
  }

  if (output.toLowerCase().startsWith('tel:')) {
    stats.stringPatternRedactions += 1;
    output = 'tel:[REDACTED_PHONE]';
  }

  return output;
}

function redactValue(value: unknown, stats: Stats): unknown {
  if (typeof value === 'string') {
    return redactString(value, stats);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, stats));
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    Object.entries(input).forEach(([key, entry]) => {
      if (ARRAY_CLEAR_KEYS.has(key) && Array.isArray(entry)) {
        output[key] = [];
        stats.contactArraysCleared += 1;
        return;
      }

      if (STRING_FIELD_KEYS.has(key)) {
        if (typeof entry === 'string' && entry.length > 0) {
          output[key] = '';
          stats.stringFieldsRedacted += 1;
        } else {
          output[key] = entry;
        }
        return;
      }

      output[key] = redactValue(entry, stats);
    });

    return output;
  }

  return value;
}

function run(): void {
  const stats: Stats = {
    files: 0,
    stringFieldsRedacted: 0,
    contactArraysCleared: 0,
    stringPatternRedactions: 0,
  };

  for (const dir of TARGET_DIRS) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(dir, file));

    for (const filePath of files) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const redacted = redactValue(parsed, stats);
      fs.writeFileSync(filePath, JSON.stringify(redacted, null, 2), 'utf-8');
      stats.files += 1;
    }
  }

  console.log(`Redacted personal data in ${stats.files} files.`);
  console.log(`Cleared contact arrays: ${stats.contactArraysCleared}`);
  console.log(`Redacted contact fields: ${stats.stringFieldsRedacted}`);
  console.log(`Redacted email/phone patterns: ${stats.stringPatternRedactions}`);
}

try {
  run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('redact:data failed:', message);
  process.exit(1);
}
