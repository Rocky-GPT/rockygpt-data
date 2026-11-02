import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { addressFits, compileOfficeStaff, staffIdentityId, staffInSection } from './office-staff';

test('a name is read only beside its own address, with the title between them', () => {
  assert.deepEqual(staffInSection('Office of Specialized Services (OSS) Staff & Contact Information',
    'Dr. David C. Nast (C207) Director Phone: (201) 684-7513 TTY via NJ Relay: 711 E-mail: dnast@ramapo.edu (mailto:dnast@ramapo.edu) '
    + 'Barbara Stienstra (C206) Specialized Services Coordinator Phone: (201) 684-7655 General Main Office Email: oss@ramapo.edu (mailto:oss@ramapo.edu) '
    + 'E-mail: bstienst@ramapo.edu (mailto:bstienst@ramapo.edu)'), [
    { name: 'David C. Nast', email: 'dnast@ramapo.edu', title: 'Director' },
    // The shared mailbox names nobody; her own address comes after it, so no title reads between.
    { name: 'Barbara Stienstra', email: 'bstienst@ramapo.edu', title: null },
  ]);
  // Words glued to a name by the page's layout come apart; "McGarvey" stays one word.
  assert.deepEqual(staffInSection('Financial Aid Staff', 'Alan KashianDirector of FacilitiesE-mail: akashian@ramapo.edu Chrisanne McGarveyAssistant Director / Systems ManagerE-mail: cmcgarve@ramapo.edu'), [
    { name: 'Alan Kashian', email: 'akashian@ramapo.edu', title: 'Director of Facilities' },
    { name: 'Chrisanne McGarvey', email: 'cmcgarve@ramapo.edu', title: 'Assistant Director / Systems Manager' },
  ]);
  // A heading that is a name; a name printed in capitals reads in title case.
  assert.deepEqual(staffInSection('ANTHONY A. DOVI', 'Director of Admissions adovi@ramapo.edu'), [{ name: 'Anthony A. Dovi', email: 'adovi@ramapo.edu', title: 'Director of Admissions' }]);
  // A mailbox named like a word, or words that are not the address's name, read as nobody.
  assert.deepEqual(staffInSection('Contact', 'Government Records records@ramapo.edu Instagram Logo Laurel laurel@ramapo.edu Career Center careercenter@ramapo.edu'), []);
  assert.equal(addressFits(['Jennifer', 'K.', 'Hicks', 'McGowan'], 'jhicksmc'), true);
  assert.equal(addressFits(['Caitlyn', 'Campbell', 'Academic'], 'ccampbe4'), false);
});

test('each person is listed_by the office whose page lists them, merged with the person the graph already has', () => {
  const registrar: CampusIdentity = { id: '00000000-0000-4000-8000-000000000301', kind: 'office', name: 'Registrar', aliases: [],
    links: [{ collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['www.ramapo.edu/registrar/', 'www.ramapo.edu/registrar/staff/'] }] };
  const faculty: CampusIdentity = { id: '00000000-0000-4000-8000-000000000302', kind: 'person', name: 'Rikki Abzug', aliases: [],
    links: [{ collection: 'faculty', source_key: 'faculty', source_record_keys: ['https://www.ramapo.edu/asb/faculty/rikki-abzug#email=rabzug@ramapo.edu'] }] };
  const club: CampusIdentity = { id: '00000000-0000-4000-8000-000000000303', kind: 'office', name: 'Greek Life', aliases: [],
    links: [{ collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['www.ramapo.edu/greek/chapters-councils/ifc/'] }] };
  const page = (key: string, sections: Array<[string, string]>) => ({ source_key: 'office-pages', source_record_key: key, url: `https://${key}`,
    collected_at: '2026-11-01T00:00:00Z', sections: sections.map(([heading, text]) => ({ heading, text })) });
  const result = compileOfficeStaff([registrar, faculty, club], [
    page('www.ramapo.edu/registrar/', [['Contact', 'Beth Foster, Associate Registrar bfoster@ramapo.edu']]),
    page('www.ramapo.edu/registrar/staff/', [['Staff', 'Beth Foster Associate Registrar bfoster@ramapo.edu Rikki Abzug rabzug@ramapo.edu']]),
    // Student officers on a chapter page are students, not staff.
    page('www.ramapo.edu/greek/chapters-councils/ifc/', [['Officers', 'Matthew Cirillo President mcirill3@ramapo.edu']]),
  ]);
  assert.deepEqual(result.entities.map(e => [e.id, e.name, e.links]), [[staffIdentityId('bfoster@ramapo.edu'), 'Beth Foster',
    [{ collection: 'staff', source_key: 'office-pages', source_record_keys: ['bfoster@ramapo.edu'] }]]]);
  assert.deepEqual(result.entities[0].relationships, [{ type: 'listed_by', target_entity_id: registrar.id, evidence: [
    { collection: 'office_sections', source_key: 'office-pages', source_record_key: 'www.ramapo.edu/registrar/', field: 'sections', source_url: 'https://www.ramapo.edu/registrar/' },
    { collection: 'office_sections', source_key: 'office-pages', source_record_key: 'www.ramapo.edu/registrar/staff/', field: 'sections', source_url: 'https://www.ramapo.edu/registrar/staff/' }] }]);
  assert.deepEqual(faculty.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['listed_by', registrar.id]]);
  assert.deepEqual(result.records.rows, [{ source_record_key: 'bfoster@ramapo.edu', name: 'Beth Foster', names: ['Beth Foster'], emails: ['bfoster@ramapo.edu'],
    roles: [{ office: 'Registrar', title: 'Associate Registrar', source_url: 'https://www.ramapo.edu/registrar/' }, { office: 'Registrar', title: 'Associate Registrar', source_url: 'https://www.ramapo.edu/registrar/staff/' }],
    source_url: 'https://www.ramapo.edu/registrar/' }]);
  assert.equal(result.records.collected_at, '2026-11-01T00:00:00Z');
  assert.equal(result.linked, 2);
});
