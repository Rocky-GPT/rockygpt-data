
import { db } from '../../src/db/index';

async function main() {
  console.log('Checking for "Student Government Association" in DB...');
  
  const result = await db.query(`
    SELECT id, content, source_path, metadata
    FROM documents
    WHERE source_path LIKE '%clubs.md%'
    AND content ILIKE '%Student Government Association%'
  `);

  console.log(`Found ${result.rows.length} rows.`);
  result.rows.forEach(row => {
    console.log('--- Row ---');
    console.log(`ID: ${row.id}`);
    console.log(`Path: ${row.source_path}`);
    console.log(`Content:\n${row.content}`); 
    console.log('Metadata:', row.metadata);
  });
  
  await db.end();
}

main().catch(console.error);
