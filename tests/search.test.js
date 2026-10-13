// Run with: node --test tests/search.test.js
const test = require('node:test');
const assert = require('node:assert');
const { rank, tokenize, stem, matchesWord } = require('../search.js');

const notes = [
  { id: 'a', kind: 'problem', title: 'Servo horn slips on 3D printed gear', body: 'Press fit too loose', solution: 'Smaller hole plus set screw', tags: ['servo', 'gears'] },
  { id: 'b', kind: 'lesson', title: 'Capacitor across motor supply', body: 'Arduino kept resetting when motors started', tags: ['power'] },
  { id: 'c', kind: 'tip', title: 'Epoxy vs super glue on PLA', body: 'Epoxy holds better if you sand first', tags: ['adhesive'] },
  { id: 'd', kind: 'idea', title: 'Solar charger', body: 'Small panel for the battery', tags: [] }
];

test('tokenize drops stopwords and stems', () => {
  assert.deepStrictEqual(tokenize('The gears are slipping'), ['gear', 'slip']);
  assert.strictEqual(stem('batteries'), 'battery');
});

test('finds notes by direct words', () => {
  const r = rank(notes, 'my gear keeps slipping');
  assert.strictEqual(r[0].note.id, 'a');
});

test('finds notes through synonyms', () => {
  const r = rank(notes, 'what glue should I use');
  assert.strictEqual(r[0].note.id, 'c');
  const r2 = rank(notes, 'board resets when the stepper turns on');
  assert.strictEqual(r2[0].note.id, 'b');
});

test('excludes the note being edited and handles empty input', () => {
  assert.ok(rank(notes, 'servo gear', { excludeId: 'a' }).every(x => x.note.id !== 'a'));
  assert.deepStrictEqual(rank(notes, 'the and of'), []);
  assert.deepStrictEqual(rank([], 'servo'), []);
});

test('lessons outrank plain notes for the same match', () => {
  const r = rank([
    { id: 'n', kind: 'note', title: 'battery', body: '' },
    { id: 'l', kind: 'lesson', title: 'battery', body: '' }
  ], 'battery');
  assert.strictEqual(r[0].note.id, 'l');
});

test('matchesWord highlights synonyms', () => {
  assert.ok(matchesWord('adhesive', tokenize('glue')));
  assert.ok(!matchesWord('wood', tokenize('glue')));
});
