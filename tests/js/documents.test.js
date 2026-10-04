// The documents display (viewer/logic.js documentsStep): the port of examples/messy_docs/display.py,
// held to the reference's own output (examples/messy_docs/recordings/display-data.json) on the five
// messy-folder recordings and the helpdesk handbook. node --test tests/js/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../viewer/logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MESSY = path.join(ROOT, 'examples/messy_docs/recordings');
const HELPDESK = path.resolve(ROOT, '../agent-lab/request-queue/demo/bench-recordings/req-011-approved.recording.jsonl');
const DATA = JSON.parse(fs.readFileSync(path.join(MESSY, 'display-data.json'), 'utf8'));

function load(p) {
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows.shift();
  return { topo: header.topology, events: L.sortEvents(rows.map(L.normalizeEvent)) };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

for (const m of DATA.messy) {
  test(`messy folder, ${m.slug}: the same model as display.py`, () => {
    const r = load(path.join(MESSY, m.slug + '.recording.jsonl'));
    const got = L.documentsStep(r.topo, r.events, 'retrieve');
    assert.equal(got.length, 1);
    assert.deepEqual(plain(got[0]), m.step);
  });
}

test('messy folder: grouped by file, duplicates flagged, the stale copy kept as its own row', () => {
  const r = load(path.join(MESSY, 'refund-window.recording.jsonl'));
  const m = L.documentsStep(r.topo, r.events, 'retrieve')[0];
  assert.equal(m.layout, 'documents');
  assert.equal(m.line, 'Searched 25 documents · 192 passages · 4 given to the AI · 1 relied on');
  assert.deepEqual(m.documents.map((d) => d.file), ['Copy of Refund Policy FINAL_v2.md', 'Refund Policy FINAL_v2.md', 'refund policy (old).md', 'Returns process.docx']);
  assert.deepEqual(m.documents[0].same_text_in, ['Refund Policy FINAL_v2.md']);
  assert.deepEqual(m.documents[2].same_text_in, []);
  assert.ok(m.documents.every((d, i) => d.title_shared === i < 3));
  assert.equal(m.not_matched, 21);
});

test('messy folder: several passages of one file are one row, with pages', () => {
  const r = load(path.join(MESSY, 'jargon.recording.jsonl'));
  const m = L.documentsStep(r.topo, r.events, 'retrieve')[0];
  const hb = m.documents.find((d) => d.file.startsWith('Employee Handbook'));
  assert.equal(hb.passages.length, 3);
  assert.match(hb.passages[0].location, /^page \d+ · passage \d+ of 152$/);
});

test('helpdesk handbook: one document, 16 numbered sections, from the same code', { skip: !fs.existsSync(HELPDESK) }, () => {
  const r = load(HELPDESK);
  const m = L.documentsStep(r.topo, r.events, 'retrieve')[0];
  assert.deepEqual(plain(m), DATA.helpdesk.step);
  assert.equal(m.layout, 'sections');
  assert.deepEqual(m.sections.map((s) => s.face), ['Preamble'].concat(Array.from({ length: 15 }, (_, i) => String(i + 1))));
});

test('dates and years are not section numbers', () => {
  const topo = { sources: [{ id: 's', title: 'Notes', kind: 'documents', description: '',
    items: [{ id: 'a', title: '2023-01-15 shipping notes' }, { id: 'b', title: '2024 rates' }, { id: 'c', title: 'Holiday hours' }] }] };
  const events = [{ event_type: 'retrieval', node: 'r', ts: 1, data: { source: 's', hits: [{ id: 'a', text: 'x' }] } }];
  assert.equal(L.documentsStep(topo, events)[0].layout, 'documents');
});

test('one numbered file among several is still a list, not a grid', () => {
  const topo = { sources: [{ id: 's', title: 'Drive', kind: 'documents', items: [
    { id: 'faq.md#1', title: '1. Price match' }, { id: 'faq.md#2', title: '2. Returns' }, { id: 'notes.txt#1', title: 'notes' }] }] };
  const events = [{ event_type: 'retrieval', node: 'r', ts: 1, data: { source: 's', query: 'price match', hits: [{ id: 'faq.md#1', text: 'We price match. Ask us.' }] } }];
  const m = L.documentsStep(topo, events)[0];
  assert.equal(m.layout, 'documents');
  assert.equal(m.documents[0].file, 'faq.md');
  assert.equal(m.documents[0].passages[0].location, 'passage 1 of 2');
  assert.equal(m.documents[0].passages[0].snippet, 'We price match.');
});

test('caps: at most 3 passages a file, then "+N more"', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `big.pdf#${i + 1}`, title: 'Big' }));
  const topo = { sources: [{ id: 's', title: 'Drive', kind: 'documents', items }] };
  const events = [{ event_type: 'retrieval', node: 'r', ts: 1, data: { source: 's', hits: items.slice(0, 5).map((it) => ({ id: it.id, text: 'text ' + it.id })) } }];
  const d = L.documentsStep(topo, events)[0].documents[0];
  assert.equal(d.passages.length, 3);
  assert.equal(d.more, 2);
});

test('Level 0 (no map): hits that name their file and page are grouped by it', () => {
  const events = [{ event_type: 'retrieval', node: 'r', ts: 1, data: { query: 'loaner', hits: [
    { id: 'scan_0042.pdf#0', document: 'scan_0042.pdf', page: 1, text: 'LOANER UNIT PROGRAM. Effective immediately we can offer a loaner.' },
    { id: 'faq.md#1', document: 'faq.md', text: 'Loaner? Ask a lead.' }] } }];
  const m = L.documentsStep({}, events)[0];
  assert.equal(m.layout, 'documents');
  assert.deepEqual(m.documents.map((d) => d.file), ['scan_0042.pdf', 'faq.md']);
  assert.equal(m.documents[0].passages[0].location, 'page 1');
  assert.match(m.line, /^Searched · 2 found · given to the AI: not known · 0 relied on$/);
});

test('the snippet: the sentence that shares the most words with the query, cut at a word', () => {
  assert.equal(L.snippet('Intro line. Customers have 45 days to return an item. Other.', 'how long to return an item'), 'Customers have 45 days to return an item.');
  assert.equal(L.snippet('Nothing in common here. At all.', 'zebra'), 'Nothing in common here.');
  const long = L.snippet('word '.repeat(80), null);
  assert.ok(long.length <= 201 && long.endsWith('…'));
});
