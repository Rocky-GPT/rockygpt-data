import { db } from '../src/db/index';

async function checkSources() {
  const result = await db.query('SELECT DISTINCT metadata as meta FROM documents LIMIT 20');
  console.log('Sample sources ingested:');
  result.rows.forEach(row => {
    console.log('-', row.meta.source);
  });
  await db.end();
}

checkSources();
