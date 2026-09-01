/**
 * When a proven contract call may be carried over to the next attempt.
 *
 * A refused dust proof is a complaint about the fee, so the call's proof is
 * still good and re-proving it costs 30-100s of wasm for an identical result.
 * The one thing that can invalidate it is the contract moving underneath: the
 * call carries a transcript that has to replay against current state, and a
 * call that lands and FAILS costs its fee exactly like one that succeeds.
 *
 * So this predicate is deliberately asymmetric. Rebuilding when it was not
 * necessary costs time. Reusing when it was not safe costs a fee and writes
 * nothing, so every uncertain answer has to come out as "rebuild".
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proofReusable } from '../../scripts/lib/preprod-runner.mjs';

const action = (hash, height = 100) => ({ type: 'ContractCall', hash, height });
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('an unmoved contract licenses the reuse', () => {
    assert.equal(proofReusable(action(A), action(A)), null);
});

test('height may advance as long as the action is the same', () => {
    // The height is incidental; identity is the hash.
    assert.equal(proofReusable(action(A, 100), action(A, 137)), null);
});

test('a contract that moved on forces a rebuild', () => {
    const why = proofReusable(action(A), action(B));
    assert.ok(why, 'must refuse');
    assert.match(why, /moved on to b{64}/);
});

test('an indexer that will not answer forces a rebuild', () => {
    // The dangerous reading: null === null is "unchanged". It is not - it is
    // "unknown", and unknown has to cost proving time rather than a fee.
    assert.ok(proofReusable(action(A), null), 'null answer must refuse');
    assert.match(proofReusable(action(A), null), /did not say/);
    assert.ok(proofReusable(action(A), {}), 'an answer without a hash must refuse');
    assert.ok(proofReusable(action(A), { hash: null }), 'an explicit null hash must refuse');
});

test('two unknowns are not a match', () => {
    // Both sides null would compare equal under a naive ===, and would then
    // license reuse on no evidence at all.
    assert.ok(proofReusable(null, null), 'null/null must refuse');
    assert.ok(proofReusable(undefined, undefined), 'undefined/undefined must refuse');
    assert.ok(proofReusable({}, {}), 'empty/empty must refuse');
});

test('a proof made against an unknown state is never reusable', () => {
    assert.ok(proofReusable(null, action(A)), 'unknown at build must refuse');
    assert.match(proofReusable(null, action(A)), /no recorded action/);
});

test('every refusal explains itself', () => {
    // The reason is logged and is the only account of why a stage spent
    // another 30-100s proving, so it must never be empty.
    for (const [a, b] of [[null, null], [action(A), null], [action(A), action(B)], [{}, action(A)]]) {
        const why = proofReusable(a, b);
        assert.equal(typeof why, 'string');
        assert.ok(why.length > 10, `unhelpful reason: ${JSON.stringify(why)}`);
    }
});
