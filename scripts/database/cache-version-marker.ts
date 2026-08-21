import fs from 'fs';
import path from 'path';

interface CorpusVersionState {
  updatedAt: string;
  contextIngestedAt?: string;
  contextSourceCount?: number;
  factsIngestedAt?: string;
  factsCount?: number;
}

const MARKER_PATH = path.join(process.cwd(), 'data', 'cache', 'corpus-version.json');

function readMarkerState(): CorpusVersionState | null {
  try {
    if (!fs.existsSync(MARKER_PATH)) return null;
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as CorpusVersionState;
  } catch {
    return null;
  }
}

export function updateCorpusVersionMarker(patch: Partial<CorpusVersionState>): void {
  const current = readMarkerState() ?? { updatedAt: new Date(0).toISOString() };
  const next: CorpusVersionState = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

