import { FileRepositoryV2 } from './file-repository';
import { PostgresRepositoryV2 } from './postgres-repository';
import type { RockyRepositoryV2 } from './types';

let cachedRepository: RockyRepositoryV2 | null = null;

export function getRepositoryV2(): RockyRepositoryV2 {
  if (cachedRepository) return cachedRepository;

  const requestedSource = process.env.V2_DATA_SOURCE;
  const connectionString = process.env.DATABASE_URL;
  const production = process.env.NODE_ENV === 'production';

  if (production) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for the production data source.');
    }
    cachedRepository = new PostgresRepositoryV2(connectionString);
    return cachedRepository;
  }

  if (requestedSource === 'file') {
    cachedRepository = new FileRepositoryV2();
    return cachedRepository;
  }

  if (connectionString) {
    cachedRepository = new PostgresRepositoryV2(connectionString);
    return cachedRepository;
  }

  if (requestedSource && requestedSource !== 'file') {
    throw new Error(`DATABASE_URL is required for V2_DATA_SOURCE=${requestedSource}.`);
  }

  // Local development and credential-free tests retain a deterministic file
  // mode. ROCKY_DATA_ROOT can point this repository at committed fixtures.
  cachedRepository = new FileRepositoryV2();
  return cachedRepository;
}

export function setRepositoryV2ForTests(repository: RockyRepositoryV2 | null): void {
  cachedRepository = repository;
}
