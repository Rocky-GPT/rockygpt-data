import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import type { GraphRecordCollectionData, GraphRecordRow } from './graph-records';

/**
 * @module data-v2/menu-boards
 * The items a dining venue's menu board lists, for a venue that publishes a menu file instead of
 * dated menus (The Atrium's "Atrium Menu Boards 2026" PDF).
 *
 * The items are a reviewed list read from the file's rendered pages (src/reference/
 * atrium-menu-board.json), each as its board prints it: station, section, name, description,
 * prices and calories, and the allergens the board says it contains. A build publishes them as
 * `menu_board_items` records the venue links only while this release's dining capture still lists
 * that exact file for that venue. When the dining site links a new file, the items are left out and
 * reported until someone reads the new one, so a student never hears an old board's prices.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export interface MenuBoardPrice { size?: string; price: string | null; calories?: string }
export interface MenuBoardOption { group: string; name: string; calories?: string; price?: string; prices?: MenuBoardPrice[] }
export interface MenuBoardItem {
  page: number; station: string | null; section: string; name: string;
  description?: string; prices?: MenuBoardPrice[]; calories?: string; contains?: string; options?: MenuBoardOption[]; note?: string;
}
export interface ReviewedMenuBoard { venue: string; document_url: string; document_title: string; document_sha256: string; read_at: string; items: MenuBoardItem[] }

export const menuBoardItemKey = (item: Pick<MenuBoardItem, 'page' | 'station' | 'section' | 'name'>): string =>
  `${item.page}:${item.station ?? '-'}:${item.section}:${item.name}`;

export function compileMenuBoard(entities: CampusIdentity[], menuDocuments: Row[], reviewed: ReviewedMenuBoard, collectedAt = ''):
  { records: GraphRecordCollectionData; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const empty = { records: { source_key: 'dining', collected_at: collectedAt, rows: [] }, unresolved };
  const venues = entities.filter(e => e.kind === 'venue' && e.name === reviewed.venue);
  if (venues.length !== 1) {
    unresolved.push({ entity: reviewed.venue, collection: 'menu_board_items', reason: `The menu board names ${venues.length} venues called ${reviewed.venue}; its items are left out.`, kind: 'missing_connection' });
    return empty;
  }
  const listed = menuDocuments.find(row => text(row.name) === reviewed.venue && text(row.url) === reviewed.document_url);
  if (!listed) {
    unresolved.push({ entity: reviewed.venue, collection: 'menu_documents', record: reviewed.document_title,
      reason: 'The dining site no longer links the menu file these items were read from; they are left out until someone reads the new file.', kind: 'missing_connection' });
    return empty;
  }
  const rows: GraphRecordRow[] = reviewed.items.map(item => ({
    source_record_key: menuBoardItemKey(item), venue: reviewed.venue, ...item,
    document_title: reviewed.document_title, read_at: reviewed.read_at, source_url: reviewed.document_url,
  }));
  const [venue] = venues;
  venue.links.push({ collection: 'menu_board_items', source_key: 'dining', source_record_keys: rows.map(row => row.source_record_key).sort() });
  return { records: { source_key: 'dining', collected_at: collectedAt || text(listed.collected_at), rows }, unresolved };
}
