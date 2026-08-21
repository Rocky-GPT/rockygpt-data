import type { DiningVenueRecord } from './schemas';

/**
 * The current menu collector is the Birch Tree Inn feed. Keeping that source
 * fact here prevents a venue-specific request from being answered with another
 * venue's menu. This is dataset metadata, not a user-phrase alias.
 */
export const CURRENT_MENU_VENUE_ID = 'birch-tree-inn';
export const CURRENT_MENU_VENUE_NAME = 'Birch Tree Inn';

export function diningVenueId(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function diningVenueRecord(name: string): DiningVenueRecord {
  const id = diningVenueId(name);
  return {
    id,
    name,
    capabilities: id === CURRENT_MENU_VENUE_ID ? ['hours', 'menu'] : ['hours'],
  };
}
