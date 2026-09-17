/**
 * @module directory/phone-normalizer
 * Deterministic telephone normalization and classification for campus contacts.
 *
 * Implements strict zero-hallucination rules:
 * 1. Captures `raw_phone` verbatim before any modifications.
 * 2. Formats dialable US numbers to canonical E.164 (`+1XXXXXXXXXX`) and formatted display (`(XXX) XXX-XXXX`).
 * 3. Never infers `type` (e.g. 'office', 'cell', 'primary', 'alternate') unless explicitly provided by the source text.
 * 4. Preserves order of multi-phone numbers exactly as published.
 * 5. Handles extension-only values ('Ext. 7609') without guessing or fabricating full telephone numbers.
 * 6. Extracts explicit email preference notes ('best to use e-mail') into `prefers_email`, `preferred_contact`, and `contact_note`.
 */

export interface PhoneEntry {
  /** E.164 format, e.g. "+12016849953" (when dialable phone exists) */
  number?: string;
  /** Extension digits, e.g. "7609" (when extension exists) */
  extension?: string;
  /** Explicit source label only: "office", "cell", "fax" (never inferred) */
  type?: string;
}

export type PhoneNormalizationStatus =
  | 'normalized'
  | 'extension_only'
  | 'multi_phone'
  | 'none'
  | 'unparsed';

export interface NormalizedContactPhoneResult {
  /** Verbatim raw phone input captured before any alteration */
  raw_phone: string | null;
  /** Primary human-friendly display string for table rendering & backward compatibility */
  phone: string | null;
  /** Structured machine-readable phone entries */
  phones: PhoneEntry[];
  /** "email" if contact explicitly prefers email communication, else null */
  preferred_contact: string | null;
  /** Extracted note or advice from the source string, e.g. "best to use e-mail" */
  contact_note: string | null;
  /** Explicit boolean flag for fast SQL/API queries */
  prefers_email: boolean;
  /** Operational/pipeline audit status */
  phone_normalization_status: PhoneNormalizationStatus;
}

/** Formats a 10-digit E.164 (+1XXXXXXXXXX) number into standard US display: (XXX) XXX-XXXX */
export function formatE164ToDisplay(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) {
    return `(${m[1]}) ${m[2]}-${m[3]}`;
  }
  return e164;
}

/**
 * Normalizes an arbitrary raw phone string from directory sources into structured data.
 */
export function parseAndNormalizePhone(raw: string | undefined | null): NormalizedContactPhoneResult {
  if (raw === undefined || raw === null) {
    return {
      raw_phone: null,
      phone: null,
      phones: [],
      preferred_contact: null,
      contact_note: null,
      prefers_email: false,
      phone_normalization_status: 'none',
    };
  }

  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    return {
      raw_phone: null,
      phone: null,
      phones: [],
      preferred_contact: null,
      contact_note: null,
      prefers_email: false,
      phone_normalization_status: 'none',
    };
  }

  const raw_phone = rawTrimmed;
  let text = rawTrimmed;

  // 1. Detect and extract email preferences / notes
  let prefers_email = false;
  let preferred_contact: string | null = null;
  let contact_note: string | null = null;

  const emailNoteMatch = text.match(/\(([^)]*(?:email|e-mail)[^)]*)\)/i);
  if (emailNoteMatch) {
    prefers_email = true;
    preferred_contact = 'email';
    contact_note = emailNoteMatch[1].trim();
    // Remove the parenthetical note from the dialable string
    text = text.replace(emailNoteMatch[0], '').trim();
  }

  // 2. Detect extension-only pattern: e.g. "Ext. 7609" or "ext 7537" or "x7537"
  const extOnlyMatch = text.match(/^(?:ext\.?|extension)\s*(\d{3,5})$/i);
  if (extOnlyMatch) {
    const ext = extOnlyMatch[1];
    return {
      raw_phone,
      phone: `Ext. ${ext}`,
      phones: [{ extension: ext }],
      preferred_contact,
      contact_note,
      prefers_email,
      phone_normalization_status: 'extension_only',
    };
  }

  // 3. Multi-phone splitting (e.g. "/" or " or ")
  const segments = text.split(/\s+(?:\/|or)\s+/i).map((s) => s.trim()).filter(Boolean);

  const phones: PhoneEntry[] = [];
  const displayParts: string[] = [];

  for (const segment of segments) {
    // Check for explicit label: e.g. (Office), (Cell), (Mobile), (Fax)
    let explicitType: string | undefined = undefined;
    const labelMatch = segment.match(/\((office|cell|mobile|fax|home|direct)\)/i);
    let numPart = segment;
    if (labelMatch) {
      const matched = labelMatch[1].toLowerCase();
      explicitType = matched === 'mobile' ? 'cell' : matched;
      numPart = segment.replace(labelMatch[0], '').trim();
    }

    // Extract digits
    const digitsMatch = numPart.match(/(?:\+?1[-.\s]*)?\(?(\d{3})\)?[-.\s]*(\d{3})[-.\s]*(\d{4})/);
    if (digitsMatch) {
      const area = digitsMatch[1];
      const prefix = digitsMatch[2];
      const line = digitsMatch[3];
      const e164 = `+1${area}${prefix}${line}`;
      const display = `(${area}) ${prefix}-${line}`;

      const entry: PhoneEntry = { number: e164 };
      if (explicitType) {
        entry.type = explicitType;
      }
      phones.push(entry);

      if (explicitType) {
        // Capitalize for display: "Office", "Cell"
        const cap = explicitType.charAt(0).toUpperCase() + explicitType.slice(1);
        displayParts.push(`${display} (${cap})`);
      } else {
        displayParts.push(display);
      }
    } else {
      // Check if this segment was an extension attached to an earlier phone
      const attachedExt = numPart.match(/(?:ext\.?|x)\s*(\d{3,5})/i);
      if (attachedExt && phones.length > 0) {
        phones[phones.length - 1].extension = attachedExt[1];
      }
    }
  }

  if (phones.length === 0) {
    // Unparsed or unrecognized string
    return {
      raw_phone,
      phone: rawTrimmed,
      phones: [],
      preferred_contact,
      contact_note,
      prefers_email,
      phone_normalization_status: 'unparsed',
    };
  }

  const status: PhoneNormalizationStatus =
    phones.length > 1 ? 'multi_phone' : 'normalized';

  const phoneDisplay =
    displayParts.length > 1 ? displayParts.join(' / ') : displayParts[0] || null;

  return {
    raw_phone,
    phone: phoneDisplay,
    phones,
    preferred_contact,
    contact_note,
    prefers_email,
    phone_normalization_status: status,
  };
}
