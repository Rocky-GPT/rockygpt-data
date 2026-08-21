import { assertQualityV2, validateCurrentDatasetV2 } from '../quality/validate';

export const CRITICAL_FACT_VALUES_V2: Record<string, string> = {
  'safety.emergency_phone': '201-684-6666',
  'safety.non_emergency_phone': '201-684-7432',
  'safety.id_card_room_phone': '201-684-7789',
  'safety.id_card_room_location': 'C-101',
  'safety.id_card_room_email': 'publicsafety@ramapo.edu',
  'password.reset_url': 'https://password.ramapo.edu/',
  'printing.free_pages_per_academic_year': '200',
  'tuition.nj_12_18_semester': '$8,807.68',
  'calendar.spring2026.add_drop_100_refund.full': 'January 26, 2026',
  'calendar.spring2026.spring_break.start': 'March 15, 2026',
  'calendar.spring2026.spring_break.end': 'March 22, 2026',
  'calendar.spring2026.finals.start': 'May 6, 2026',
  'shuttle.ramsey_route17.express.first_departure': '7:00 AM',
  'shuttle.ramsey_route17.express.last_dropoff': '5:40 PM',
};

export const CRITICAL_FACT_VALIDITY_V2: Record<
  string,
  { validFrom?: string; validUntil?: string }
> = {
  'calendar.spring2026.add_drop_100_refund.full': {
    validFrom: '2025-08-01',
    validUntil: '2026-05-31',
  },
  'calendar.spring2026.spring_break.start': {
    validFrom: '2025-08-01',
    validUntil: '2026-05-31',
  },
  'calendar.spring2026.spring_break.end': {
    validFrom: '2025-08-01',
    validUntil: '2026-05-31',
  },
  'calendar.spring2026.finals.start': {
    validFrom: '2025-08-01',
    validUntil: '2026-05-31',
  },
};

if (process.argv[1]?.endsWith('check-quality.ts')) {
  try {
    const summary = validateCurrentDatasetV2(CRITICAL_FACT_VALUES_V2);
    assertQualityV2(summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
