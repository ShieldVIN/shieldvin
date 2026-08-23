/**
 * Regression guard for docs/FIELDS.md.
 *
 * Every claim our field registry depends on, asserted against the ACTUALLY
 * INSTALLED @odatano/dpp-sdk rather than its published source. ODATANO ships
 * breaking changes on a 0.x line roughly weekly, so re-run this after ANY
 * @odatano/* version bump and before trusting the registry design.
 *
 *   npm run test:sdk
 *
 * Last full pass: dpp-sdk 0.2.0 — 24/24 on 2026-08-23.
 */
import {
  VAULT_SLOT_WIDTHS, MERKLE_DEPTH, LEAF_COUNT, DEFAULT_SLOT_WIDTH,
  depthForWidth, widthForDepth, padToWidth,
  buildTree, proofFor, verifyProof,
} from '@odatano/dpp-sdk/merkle';
import {
  PROVABLE_FIELDS, VALUE_SCALE, provableFieldKind, scaleValue, fieldKeyHex,
} from '@odatano/dpp-sdk/fields';
import { blake2b } from '@noble/hashes/blake2';

let pass = 0, fail = 0;
const check = (claim, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${claim}`);
  if (!ok) console.log(`        expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const checkThrows = (claim, fn) => {
  let threw = false, msg = '';
  try { fn(); } catch (e) { threw = true; msg = e.message; }
  threw ? pass++ : fail++;
  console.log(`  ${threw ? 'PASS' : 'FAIL'}  ${claim}`);
  if (threw) console.log(`        threw: ${msg.slice(0, 90)}`);
};

console.log('\n--- Slot widths -------------------------------------------------');
check('VAULT_SLOT_WIDTHS === [8, 16, 32]', [...VAULT_SLOT_WIDTHS], [8, 16, 32]);
check('MERKLE_DEPTH === 4 (default)', MERKLE_DEPTH, 4);
check('LEAF_COUNT === 16', LEAF_COUNT, 16);
check('DEFAULT_SLOT_WIDTH === 16', DEFAULT_SLOT_WIDTH, 16);
check('depthForWidth(16) === 4', depthForWidth(16), 4);
check('depthForWidth(32) === 5  <-- our choice', depthForWidth(32), 5);
check('depthForWidth(8) === 3', depthForWidth(8), 3);
check('widthForDepth(5) === 32', widthForDepth(5), 32);
checkThrows('depthForWidth(24) throws on non-power-of-two', () => depthForWidth(24));

console.log('\n--- Numeric encoding --------------------------------------------');
check('VALUE_SCALE === 1000', VALUE_SCALE, 1000);
check('scaleValue(123.456) === 123456', scaleValue(123.456), 123456);
check('scaleValue("0.001") === 1', scaleValue('0.001'), 1);
check('scaleValue(0) === 0', scaleValue(0), 0);

console.log('\n--- Field kinds and ordering ------------------------------------');
const kinds = PROVABLE_FIELDS.map(provableFieldKind);
const firstString = kinds.indexOf('string');
const lastNumeric = kinds.lastIndexOf('numeric');
check('provableFieldKind(unknown) === null', provableFieldKind('nope_not_a_field'), null);
check(
  'all numerics precede all strings in the shipped registry',
  firstString === -1 || lastNumeric < firstString,
  true,
);
console.log(`        registry: ${kinds.filter(k => k === 'numeric').length} numeric, ` +
            `${kinds.filter(k => k === 'string').length} string, ${PROVABLE_FIELDS.length} total`);

console.log('\n--- Field key derivation ----------------------------------------');
const name = 'odometerKm';
const expected = Buffer.from(blake2b(new TextEncoder().encode(name), { dkLen: 32 })).toString('hex');
check(`fieldKeyHex("${name}") === blake2b-256(name)`, fieldKeyHex(name), expected);
check('fieldKeyHex is 64 hex chars (32 bytes)', fieldKeyHex(name).length, 64);

console.log('\n--- padToWidth overflow behaviour -------------------------------');
const filler = () => new Uint8Array(32);
check('padToWidth pads 26 -> 32', padToWidth(Array(26).fill(new Uint8Array(32)), 32, filler).length, 32);
checkThrows(
  'padToWidth THROWS when registry exceeds width (33 into 32)',
  () => padToWidth(Array(33).fill(new Uint8Array(32)), 32, filler),
);

console.log('\n--- Depth-5 tree round trip (our 32-slot panel) ------------------');
const nodeHash = (l, r) => blake2b(Uint8Array.from([...l, ...r]), { dkLen: 32 });
const leaves = Array.from({ length: 32 }, (_, i) =>
  blake2b(new TextEncoder().encode(`slot-${i}`), { dkLen: 32 }));
const tree = buildTree(leaves, nodeHash);
check('depth-5 tree has 6 levels (leaves + 5)', tree.levels.length, 6);
check('root level holds exactly 1 node', tree.levels[5].length, 1);
check('rootHex is 64 hex chars', tree.rootHex.length, 64);

let allPaths = true;
for (let i = 0; i < 32; i++) {
  const path = proofFor(tree.levels, i);
  if (path.siblings.length !== 5) { allPaths = false; break; }
  if (!verifyProof(leaves[i], path, tree.rootHex, nodeHash)) { allPaths = false; break; }
}
check('all 32 inclusion proofs have 5 siblings and verify', allPaths, true);

const bad = proofFor(tree.levels, 0);
check('a proof for slot 0 does NOT verify slot 1 (soundness)',
  verifyProof(leaves[1], bad, tree.rootHex, nodeHash), false);

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
