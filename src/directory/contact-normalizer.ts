/** Formatting of published directory fields. Never infer a unit, status, or contact method. */
export interface ContactFieldInput {
  id?: string;
  name: string;
  type?: 'person' | 'office';
  title?: string | null;
  department?: string | null;
  status?: 'retired' | null;
  office?: string | null;
  offices?: string[] | null;
}

export interface NormalizedContactFields {
  id?: string;
  name: string;
  type?: 'person' | 'office';
  title?: string;
  department?: string;
  status?: 'retired';
  offices?: string[];
}

function text(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

/** Only compact room codes are reformatted; named locations retain their supplied text. */
export function normalizeOffice(value: string): string {
  const cleaned = text(value);
  const code = cleaned.match(/^([A-Z]{1,4})[ -]*(\d{3})(?:[ -]*([A-Z]))?$/);
  return code ? `${code[1]}-${code[2]}${code[3] ?? ''}` : cleaned;
}

/** Split the trailing balanced school parentheses used by the old faculty publisher. */
export function splitPublishedFacultyDepartment(value: string): { title?: string; department?: string } {
  const combined = text(value);
  if (!combined.endsWith(')')) return /^(?:School\b|Anisfield School\b|Library Faculty\b)/.test(combined)
    ? { department: combined } : combined ? { title: combined, department: undefined } : {};
  let depth = 0;
  for (let i = combined.length - 1; i >= 0; i--) {
    if (combined[i] === ')') depth++;
    if (combined[i] === '(') depth--;
    if (depth === 0) {
      const unit = combined.slice(i + 1, -1);
      // A retirement suffix alone is not an organizational unit.
      if (i > 0 && combined[i - 1] === ' ' && /^(?:School\b|Anisfield School\b|Library Faculty\b)/.test(unit)) {
        return { title: text(combined.slice(0, i)), department: unit };
      }
      break;
    }
  }
  // With no reliable delimiter, retain the source text for review rather than inventing a unit.
  return combined ? { title: combined, department: undefined } : {};
}

export function normalizeContactFields(input: ContactFieldInput): NormalizedContactFields {
  let retired = input.status === 'retired';
  function withoutRetirement(value: string | null | undefined): string {
    const cleaned = text(value);
    const suffix = /(?:\s*[-–—]\s*Retired|\s*\(Retired\)|^Retired)$/i;
    if (!suffix.test(cleaned)) return cleaned;
    retired = true;
    return text(cleaned.replace(suffix, ''));
  }
  const title = withoutRetirement(input.title);
  const department = withoutRetirement(input.department);
  const supplied = input.offices ?? (input.office ? [input.office] : []);
  const offices = supplied.flatMap((office) => {
    const parts = office.split('/');
    // Slash splitting is safe only when every part is an explicit room code.
    return parts.length > 1 && parts.every(p => /^[A-Z]{1,4}[ -]*\d{3}(?:[ -]*[A-Z])?$/.test(text(p)))
      ? parts.map(normalizeOffice)
      : [normalizeOffice(office)];
  }).filter(Boolean);
  return {
    ...(input.id ? { id: input.id } : {}),
    ...(input.type ? { type: input.type } : {}),
    name: text(input.name),
    ...(title ? { title } : {}),
    ...(department ? { department } : {}),
    ...(retired ? { status: 'retired' as const } : {}),
    ...(offices.length ? { offices } : {}),
  };
}

export interface ReviewContact extends NormalizedContactFields {
  id: string;
  phones?: { number?: string; extension?: string }[];
  email?: string;
}

export interface ContactReviewFlag {
  reason: 'missing_contact_method' | 'unfinished_title' | 'unusual_name_ending' | 'shared_phone_with_retired_contact' | 'unknown_contact_type';
  related_ids?: string[];
}

/** Review findings are metadata; they never change or merge directory identities. */
export function reviewContacts(contacts: ReviewContact[]): Record<string, ContactReviewFlag[]> {
  const flags: Record<string, ContactReviewFlag[]> = {};
  for (const contact of contacts) {
    const review: ContactReviewFlag[] = [];
    if (!contact.type) review.push({ reason: 'unknown_contact_type' });
    if (!contact.email && !contact.phones?.some(p => p.number || p.extension)) review.push({ reason: 'missing_contact_method' });
    if (/Liaison:\s*$/i.test(contact.title ?? '')) review.push({ reason: 'unfinished_title' });
    if (/[´`ˊˋ]$/.test(contact.name)) review.push({ reason: 'unusual_name_ending' });
    const shared = contact.type === 'person' ? contacts.filter(other =>
      other.id !== contact.id && other.type === 'person' &&
      (contact.status === 'retired' || other.status === 'retired') &&
      contact.phones?.some(p => p.number && other.phones?.some(q => q.number === p.number))
    ).map(other => other.id) : [];
    if (shared.length) review.push({ reason: 'shared_phone_with_retired_contact', related_ids: shared });
    flags[contact.id] = review;
  }
  return flags;
}
