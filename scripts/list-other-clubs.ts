
import fs from 'fs';
import path from 'path';

type ClubRecord = {
  bucket?: string;
  name?: string;
};

const clubsPath = path.join(process.cwd(), 'data/normalized/clubs.json');
const clubs = JSON.parse(fs.readFileSync(clubsPath, 'utf-8')) as ClubRecord[];

const targetBuckets = ['other', 'departments', 'office_sponsored', 'residence_life'];

const results: Record<string, string[]> = {};

clubs.forEach((club) => {
  if (!club.bucket || !club.name) return;

  if (targetBuckets.includes(club.bucket)) {
    if (!results[club.bucket]) {
      results[club.bucket] = [];
    }
    results[club.bucket].push(club.name);
  }
});

console.log(JSON.stringify(results, null, 2));
