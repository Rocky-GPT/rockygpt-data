import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { compileAthleticsTeams, gameDate, parseCoaches, parseSchedule, teamId, type AthleticsCapture } from './athletics';

// Shaped like the athletics site's (Sidearm) schedule list: one <li> per game, then the same games
// again as cards, which must not be read twice.
const game = (cls: string, date: string, time: string, atVs: string, opponent: string, city: string, venue: string, result = '', note = '') => `
  <li class="sidearm-schedule-game ${cls}">
    <div class="sidearm-schedule-game-opponent-date"><span>${date}</span> <span>${time}</span></div>
    <div class="sidearm-schedule-game-opponent-text">
      <div class="sidearm-schedule-game-opponent-name"><a href="#">${opponent}</a></div>
      ${note ? `<div class="sidearm-schedule-game-opponent-text-promotion">${note}</div>` : ''}
    </div>
    <div class="sidearm-schedule-game-location"><span class="sidearm-schedule-game-conference-vs"><span class="sidearm-schedule-game-at-vs">${atVs}</span></span>
      <span>${city}</span> <span>${venue}</span></div>
    ${result ? `<div class="sidearm-schedule-game-result"><span>${result.split(',')[0]},</span> <span>${result.split(',')[1]}</span></div>` : ''}
  </li>`;
const schedule = `<html><head><title>2026-2027 Women's Basketball Schedule - Ramapo College of New Jersey Athletics</title></head><body>
  <div class="sidearm-schedule-record"><ul><li><span>Overall</span><span>1-0</span></li><li><span>Conf</span><span>0-0</span></li><li><span>Streak</span><span></span></li></ul></div>
  <ul class="sidearm-schedule-games-container">
    ${game('sidearm-schedule-home-game', 'Nov 7 (Sat)', '1:00 PM', 'vs', 'The City College of New York', 'Mahwah, NJ', 'Bradley Center', 'W, 70-52')}
    ${game('sidearm-schedule-away-game sidearm-schedule-game-conference', 'Jan 14 (Wed)', '5:30 PM', 'at', 'Kean University', 'Union, NJ', 'Harwood Arena')}
    ${game('sidearm-schedule-neutral-game', 'Feb 20 (Fri)', 'TBD', 'vs', 'TBA', 'Ewing, NJ', 'Packer Hall', '', 'NJAC Tournament')}
  </ul>
  <div class="cards">${game('sidearm-schedule-home-game', 'Nov 7 (Sat)', '1:00 PM', 'vs', 'The City College of New York', 'Mahwah, NJ', 'Bradley Center', 'W, 70-52')}</div>
</body></html>`;
const coaches = `<html><body><table class="sidearm-table"><thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr></thead><tbody>
  <tr><th scope="row"><a href="/coaches/1">DJ Pinton</a></th><td>Head Coach</td><td><a href="mailto:dpinton@ramapo.edu">Email</a></td><td><a href="tel:2016847198">201-684-7198</a> 201-684-7198</td></tr>
  <tr><th scope="row"><a href="/coaches/2">Peter Bonilla</a></th><td>Assistant Coach</td><td></td><td></td></tr>
</tbody></table></body></html>`;

test('a game in a two-year season falls in its fall or spring year', () => {
  assert.equal(gameDate('Nov 7 (Sat)', '2026-2027'), '2026-11-07');
  assert.equal(gameDate('Feb 20 (Fri)', '2026-2027'), '2027-02-20');
  assert.equal(gameDate('Feb 20', '2026-27'), '2027-02-20');
  assert.equal(gameDate('Sep 2 (Tue)', '2026'), '2026-09-02');
  assert.equal(gameDate('TBA', '2026'), '');
});

test('a schedule page gives each game once, with its date, side, place and result', () => {
  const parsed = parseSchedule(schedule);
  assert.equal(parsed.title, "2026-2027 Women's Basketball Schedule");
  assert.equal(parsed.season, '2026-2027');
  assert.deepEqual(parsed.record, { Overall: '1-0', Conf: '0-0' });
  assert.equal(parsed.games.length, 3);
  assert.deepEqual(parsed.games[0], { date: '2026-11-07', date_label: 'Nov 7 (Sat)', time: '1:00 PM', site: 'home',
    opponent: 'The City College of New York', location: 'Mahwah, NJ', venue: 'Bradley Center', outcome: 'W', result: 'W, 70-52',
    note: '', conference: false });
  assert.deepEqual([parsed.games[1].site, parsed.games[1].conference, parsed.games[1].result, parsed.games[1].date], ['away', true, '', '2027-01-14']);
  assert.deepEqual([parsed.games[2].site, parsed.games[2].time, parsed.games[2].note], ['neutral', 'TBD', 'NJAC Tournament']);
});

test('a coaches page gives each coach once, with the email and phone it links', () => {
  assert.deepEqual(parseCoaches(coaches), [
    { name: 'DJ Pinton', title: 'Head Coach', email: 'dpinton@ramapo.edu', phone: '201-684-7198' },
    { name: 'Peter Bonilla', title: 'Assistant Coach', email: '', phone: '' }]);
});

test('a team is listed by Athletics, held at its home building, and reports what it could not read', () => {
  const artifact = campusBuildingsArtifact({ buildings: [
    { key: 'building_bill-bradley-sports-and-recreation-center', name: 'Bill Bradley Sports and Recreation Center', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1#!', roomPrefixes: [] }] });
  const office: CampusIdentity = { id: '00000000-0000-4000-8000-000000000501', kind: 'office', name: 'Athletics', aliases: [], links: [] };
  const page = (team: string, kind: string, html?: string) => ({ team, url: `https://ramapoathletics.com/sports/${team}/${kind}`, status: html ? 200 : 404, fetchedAt: '2026-11-03T12:00:00Z', ...html ? { html } : {} });
  const schedules: AthleticsCapture = { schemaVersion: 1, dataset: 'athletics-schedules', generatedAt: '', site: 'https://ramapoathletics.com',
    pages: [page('womens-basketball', 'schedule', schedule), page('baseball', 'schedule')] };
  const coachPages: AthleticsCapture = { ...schedules, dataset: 'athletics-coaches', pages: [page('womens-basketball', 'coaches', coaches)] };
  const reviewed = { site: 'https://ramapoathletics.com', office: 'Athletics',
    teams: [{ slug: 'womens-basketball', name: "Women's Basketball" }, { slug: 'baseball', name: 'Baseball' }],
    venues: { 'Bradley Center': 'building_bill-bradley-sports-and-recreation-center' } };
  const result = compileAthleticsTeams([office], schedules, coachPages, reviewed, artifact);
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [[teamId('womens-basketball'), 'team', "Women's Basketball"]]);
  assert.deepEqual(result.entities[0].relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : '']),
    [['listed_by', office.id], ['held_at', campusBuildingId(artifact.buildings[0])]]);
  const row = result.records.rows[0];
  assert.equal(row.source_record_key, 'womens-basketball');
  assert.equal((row.games as unknown[]).length, 3);
  assert.equal((row.coaches as Array<{ name: string }>)[0].name, 'DJ Pinton');
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.reason]), [['Baseball', "The team's schedule page was not captured; the team is left out."]]);
  // Before the first collection there is nothing to read, and nothing to report.
  assert.deepEqual(compileAthleticsTeams([office], undefined, undefined, reviewed, artifact), { entities: [], unresolved: [],
    records: { source_key: 'athletics-schedules', collected_at: '', rows: [] } });
});
