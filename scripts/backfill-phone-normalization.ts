import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { buildStructuredDirectoryContacts } from '../src/directory/structured-contacts';

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres@127.0.0.1:55432/rockygpt_development';
  console.log(`Connecting to PostgreSQL at ${connectionString}...`);

  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();

  try {
    // 1. Apply the structured phone and nullable preference schema before writing.
    for (const migration of ['017_contact_phone_normalization.sql', '022_unknown_contact_preference.sql']) {
      const migrationSql = fs.readFileSync(path.join(__dirname, '../src/data-v2/migrations', migration), 'utf8');
      await client.query(migrationSql);
    }

    // 2. Load contacts via buildStructuredDirectoryContacts
    const facultyRaw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../data/normalized/faculty.json'), 'utf8')
    );
    const directoryContacts = buildStructuredDirectoryContacts(facultyRaw);
    console.log(`Loaded ${directoryContacts.length} contacts to backfill.`);

    // 3. Backfill into rockygpt_v2.campus_contacts
    let updatedCount = 0;
    for (const contact of directoryContacts) {
      const res = await client.query(
        `UPDATE rockygpt_v2.campus_contacts
         SET 
           phone = $1,
           phones = $2::jsonb,
           preferred_contact = $3,
           contact_note = $4,
           prefers_email = $5,
           raw_phone = $6,
           phone_normalization_status = $7
         WHERE source_record_key = $8 OR (name = $9 AND department IS NOT DISTINCT FROM $10)`,
        [
          contact.phone || null,
          JSON.stringify(contact.phones || []),
          contact.preferred_contact || null,
          contact.contact_note || null,
          contact.prefers_email ?? null,
          contact.raw_phone || null,
          contact.phone_normalization_status || 'none',
          contact.sourceRecordKey,
          contact.name,
          contact.department || null,
        ]
      );
      updatedCount += res.rowCount || 0;
    }
    console.log(`Updated rows in campus_contacts: ${updatedCount}`);

    // 4. Validate all 242 records
    console.log('\n--- Running Validation Queries ---');
    const totalRes = await client.query(
      `SELECT count(*) AS total FROM rockygpt_v2.campus_contacts;`
    );
    console.log(`Total records: ${totalRes.rows[0].total}`);

    const statusRes = await client.query(
      `SELECT phone_normalization_status, count(*) 
       FROM rockygpt_v2.campus_contacts 
       GROUP BY 1 ORDER BY 2 DESC;`
    );
    console.log('Status breakdown:');
    for (const row of statusRes.rows) {
      console.log(`  ${row.phone_normalization_status}: ${row.count}`);
    }

    const emailPrefRes = await client.query(
      `SELECT name, phone, preferred_contact, contact_note, prefers_email, phones 
       FROM rockygpt_v2.campus_contacts 
       WHERE prefers_email = true;`
    );
    console.log('\nEmail preference contacts:');
    for (const row of emailPrefRes.rows) {
      console.log(
        `  ${row.name} -> phone: ${row.phone}, pref: ${row.preferred_contact}, note: "${row.contact_note}", phones: ${JSON.stringify(row.phones)}`
      );
    }

    const multiPhoneRes = await client.query(
      `SELECT name, phone, raw_phone, phones 
       FROM rockygpt_v2.campus_contacts 
       WHERE phone_normalization_status = 'multi_phone';`
    );
    console.log('\nMulti-phone contacts:');
    for (const row of multiPhoneRes.rows) {
      console.log(
        `  ${row.name} -> display: "${row.phone}", raw: "${row.raw_phone}", phones: ${JSON.stringify(row.phones)}`
      );
    }

    const extRes = await client.query(
      `SELECT name, phone, raw_phone, phones 
       FROM rockygpt_v2.campus_contacts 
       WHERE phone_normalization_status = 'extension_only';`
    );
    console.log('\nExtension-only contacts:');
    for (const row of extRes.rows) {
      console.log(
        `  ${row.name} -> display: "${row.phone}", raw: "${row.raw_phone}", phones: ${JSON.stringify(row.phones)}`
      );
    }

    // Strict assertions
    const statuses = Object.fromEntries(
      statusRes.rows.map((r) => [r.phone_normalization_status, Number(r.count)])
    );
    if (statuses['unparsed'] && statuses['unparsed'] > 0) {
      throw new Error(`Found ${statuses['unparsed']} unparsed phone records!`);
    }
    if (statuses['normalized'] !== 212) {
      throw new Error(`Expected 212 normalized records, got ${statuses['normalized']}`);
    }
    if (statuses['extension_only'] !== 2) {
      throw new Error(`Expected 2 extension_only records, got ${statuses['extension_only']}`);
    }
    if (statuses['multi_phone'] !== 2) {
      throw new Error(`Expected 2 multi_phone records, got ${statuses['multi_phone']}`);
    }
    if (statuses['none'] !== 26) {
      throw new Error(`Expected 26 none records, got ${statuses['none']}`);
    }

    console.log('\n✅ 100% of all 242 records validated successfully with zero errors!');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error during backfill:', err);
  process.exit(1);
});
