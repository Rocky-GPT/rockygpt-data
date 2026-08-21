/**
 * @module data-v2/sources
 * The canonical citation for each campus source.
 *
 * The entries live in `src/reference/sources.json` so that a service written
 * in another language can cite the same sources without reimplementing this
 * file. This module supplies the type and nothing else.
 */

import type { SourceReference } from './types';
import sourceData from '../reference/sources.json';

export const V2_SOURCES: Record<string, SourceReference> = sourceData;
