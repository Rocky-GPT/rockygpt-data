import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTermFrequencies, searchTermsFor, splitQueryWords } from './search-terms';

/** Club names, as they actually read in the dataset. */
const CLUB_NAMES = [
  'Accounting Club',
  'Active Minds',
  'A Moment of Magic',
  'African Federation of Representation and Opportunity',
  'Allies of the Ramapough Munsee',
  'Alliance of EOF and Friends',
  '1Step',
  '#WeAreRCNJ',
];

const CLUB_WORDS = new Set(['club', 'clubs', 'organization', 'join']);

test('a word naming the table is pruned even though it is never in a record', () => {
  // "clubs" appears in no club's name, so frequency pruning measures it as
  // maximally distinctive while it identifies nothing. Without the per-table
  // list, a strict match then demands a record containing "clubs".
  const frequencies = buildTermFrequencies(CLUB_NAMES);
  assert.equal(frequencies.documentFrequency.get('clubs') ?? 0, 0);

  const withoutList = searchTermsFor('what clubs can i join', frequencies);
  assert.equal(withoutList.primary, 'clubs join');

  const withList = searchTermsFor('what clubs can i join', frequencies, CLUB_WORDS);
  assert.equal(withList.primary, '');
});

test('an empty primary is what tells the caller to list the table', () => {
  // The repository turns this into a match-all query. The question named the
  // table and nothing in it, so listing it is the answer.
  const terms = searchTermsFor('what clubs can i join', buildTermFrequencies(CLUB_NAMES), CLUB_WORDS);
  assert.equal(terms.primary, '');
  assert.equal(terms.fallback, null);
});

test('a domain word does not swallow the identifying word beside it', () => {
  const terms = searchTermsFor('accounting club', buildTermFrequencies(CLUB_NAMES), CLUB_WORDS);
  assert.equal(terms.primary, 'accounting');
});

test('a word that identifies nothing is still not invented back in', () => {
  // Precision is the point of the strict match: an unknown subject must stay
  // unanswerable rather than falling back to something that shares a word.
  const terms = searchTermsFor('quantum wizardry club', buildTermFrequencies(CLUB_NAMES), CLUB_WORDS);
  assert.equal(terms.primary, 'quantum wizardry');
});

test('measured frequencies still prune words common inside the table', () => {
  // "studies" is not in the built-in generic list, so it only becomes
  // prunable by being measured as common here.
  const frequencies = buildTermFrequencies([
    'Africana Studies',
    'Environmental Studies',
    'American Studies',
    'Literature Studies',
    'Nursing',
  ]);
  const terms = searchTermsFor('environmental studies', frequencies);
  assert.equal(terms.primary, 'environmental');
  // The fallback keeps every non-generic word, so over-pruning can only cost
  // one extra query rather than an answer.
  assert.equal(terms.fallback, 'environmental studies');
});

test('domain words compose with the built-in generic list', () => {
  assert.deepEqual(splitQueryWords('what events are happening today', new Set(['events', 'happening'])), []);
  assert.deepEqual(splitQueryWords('are there vegan options', new Set(['options'])), ['vegan']);
});

test('an empty query is unchanged by pruning', () => {
  const terms = searchTermsFor('', buildTermFrequencies(CLUB_NAMES), CLUB_WORDS);
  assert.equal(terms.primary, '');
  assert.equal(terms.fallback, null);
});
