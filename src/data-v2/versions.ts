import type { DatasetContext } from './types';
import { getRepositoryV2 } from './repositories/index';

export async function getActiveDatasetVersion(): Promise<DatasetContext> {
  return getRepositoryV2().getDatasetContext();
}
