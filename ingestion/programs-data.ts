type JsonRecord = Record<string, unknown>;

export interface ValidatedProgramsData extends JsonRecord {
  generatedAt: string;
  totalSchools: number;
  totalMajors: number;
  totalPrograms?: number;
  schools: Array<
    JsonRecord & {
      school: string;
      majors: Array<JsonRecord & { name: string }>;
    }
  >;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The canonical program artifact is structured Coursedog API data. Catalog
 * HTML crawl captures (including WAF/CAPTCHA pages) are never valid program
 * records and must not be copied into data/normalized/programs.json.
 */
export function validateProgramsData(input: unknown): ValidatedProgramsData {
  assert(isRecord(input), 'programs data must be an object');
  assert(typeof input.generatedAt === 'string', 'programs.generatedAt must be a string');
  assert(Number.isFinite(Date.parse(input.generatedAt)), 'programs.generatedAt must be a date');
  assert(Array.isArray(input.schools), 'programs.schools must be an array');
  assert(input.schools.length > 0, 'programs.schools must not be empty');

  const schools = input.schools.map((school, schoolIndex) => {
    assert(isRecord(school), `programs.schools[${schoolIndex}] must be an object`);
    assert(
      typeof school.school === 'string' && school.school.trim().length > 0,
      `programs.schools[${schoolIndex}].school must be a non-empty string`
    );
    assert(
      Array.isArray(school.majors),
      `programs.schools[${schoolIndex}].majors must be an array`
    );
    const majors = school.majors.map((major, majorIndex) => {
      assert(
        isRecord(major),
        `programs.schools[${schoolIndex}].majors[${majorIndex}] must be an object`
      );
      assert(
        typeof major.name === 'string' && major.name.trim().length > 0,
        `programs.schools[${schoolIndex}].majors[${majorIndex}].name must be a non-empty string`
      );
      return major as JsonRecord & { name: string };
    });
    return {
      ...school,
      school: school.school,
      majors,
    };
  });

  const totalPrograms = schools.reduce((sum, school) => sum + school.majors.length, 0);
  assert(totalPrograms >= 50, `programs contains only ${totalPrograms} program records`);
  assert(
    typeof input.totalSchools === 'number' && input.totalSchools === schools.length,
    `programs.totalSchools must equal ${schools.length}`
  );
  assert(
    typeof input.totalMajors === 'number' && input.totalMajors === totalPrograms,
    `programs.totalMajors must equal ${totalPrograms}`
  );
  if (input.totalPrograms !== undefined) {
    assert(
      typeof input.totalPrograms === 'number' && input.totalPrograms === totalPrograms,
      `programs.totalPrograms must equal ${totalPrograms}`
    );
  }

  return {
    ...input,
    generatedAt: input.generatedAt,
    totalSchools: input.totalSchools,
    totalMajors: input.totalMajors,
    ...(typeof input.totalPrograms === 'number'
      ? { totalPrograms: input.totalPrograms }
      : {}),
    schools,
  } as ValidatedProgramsData;
}
