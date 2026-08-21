export interface FrontmatterData {
  source_url: string;
  title: string;
  trust_tier: 'official_primary' | 'official_secondary' | 'community' | 'unknown';
  freshness_sla_hours: number;
}

export function buildFrontmatter(data: FrontmatterData): string {
  return [
    '---',
    `source_url: "${data.source_url}"`,
    `title: "${data.title}"`,
    `trust_tier: ${data.trust_tier}`,
    `freshness_sla_hours: ${data.freshness_sla_hours}`,
    '---',
    '',
  ].join('\n');
}
