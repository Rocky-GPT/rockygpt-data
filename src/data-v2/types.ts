/** Types the data layer owns. */

/** The official page a fact came from. */
export interface SourceReference {
  sourceId: string;
  title: string;
  url: string;
  collectedAt?: string;
}

/** Which published dataset a repository is serving. */
export interface DatasetContext {
  id: string;
  version: string;
  activatedAt: string;
}

/**
 * A fact too important to paraphrase — an emergency number, a reset URL.
 * Stored verbatim with its own verification date so it can be served exactly.
 */
export interface CriticalFactRecord {
  key: string;
  value: string;
  source: SourceReference;
  verifiedAt: string;
  validFrom?: string;
  validUntil?: string;
}

/** A retrieved passage and how much it should be trusted. */
export interface EvidenceItem {
  /** Immutable chunk identifier within the pinned dataset/index. */
  id: string;
  /** Immutable parent document identifier within the pinned dataset/index. */
  documentId: string;
  /** Stable owner of the public citation metadata below. */
  sourceId: string;
  title: string;
  url: string;
  content: string;
  domain: string;
  trustTier: 'official_primary' | 'official_secondary' | 'community' | 'unknown';
  collectedAt: string;
  score: number;
}
