export type ExplorerValue = string | number | boolean | null;

export interface ExplorerColumn {
  key: string;
  label: string;
}

export interface ExplorerDataset {
  key: string;
  label: string;
  group: 'Campus data' | 'Retrieval' | 'Releases';
  description: string;
  columns: ExplorerColumn[];
  count: number;
}

export interface ExplorerRecords {
  datasetKey: string;
  rows: Array<Record<string, ExplorerValue>>;
  total: number;
  page: number;
  pageSize: number;
  search: string;
  sort: string;
  direction: 'asc' | 'desc';
  filters: {
    status: string;
    topic: string;
    route: string;
    dateFrom: string;
    dateTo: string;
    origins: string[];
  };
}

export interface ExplorerFilterOptions {
  topics: string[];
  routes: string[];
}

export interface ExplorerReleaseSummary {
  version: string;
  status: string;
  activatedAt: string | null;
  sourceCount: number;
  structuredRecordCount: number;
  documentCount: number;
  chunkCount: number;
  sourceStatuses: Array<{ status: string; count: number }>;
}

export interface DataExplorerPayload {
  generatedAt: string;
  datasets: ExplorerDataset[];
  records: ExplorerRecords;
  filterOptions: ExplorerFilterOptions;
  release: ExplorerReleaseSummary;
}
