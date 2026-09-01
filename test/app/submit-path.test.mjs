/**
 * The submit path's contract with @odatano/nightgate-tx.
 *
 * The engine does not classify node rejects or drive the submit socket itself;
 * it delegates both to the pinned nightgate-tx. That makes these the
 * assumptions a version bump could break silently, so they are asserted here
 * rather than discovered on a run that costs a fee.
 *
 * Two things are under test:
 *
 *   1. The sub-code table. Every code the engine branches on has to land in
 *      the kind the engine expects, across the whole set.
 *
 *   2. The one-shot submit socket. Every way it can end has to end the wait:
 *      a reply, a reject, a close without a reply, and silence.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    submitExtrinsic, classifyNodeReject,
    isPreMempoolReject, isTransportFailure, isAlreadyImported
} from '@odatano/nightgate-tx/txbuilder';

// The engine's wrappers, verbatim from preprod-runner.mjs. Kept in step by
// hand on purpose: if one changes there and not here, a test fails.
const kindOf = (m) => classifyNodeReject(m).kind;
const isStaleDustProof = (m) => kindOf(m) === 'stale-dust-proof';
const isFundsProblem = (m) => kindOf(m) === 'funds' || /InvalidTransaction::Payment/i.test(String(m));
const isSequencingProblem = (m) => kindOf(m) === 'sequencing' || /segment ordering/i.test(String(m));

const reject = (sub) => `node rejected: 1010 Invalid Transaction | {"Module":{"error":"Custom error: ${sub}"}}`;

// ---------------------------------------------------------------- sub-codes

test('a stale dust proof is a stale dust proof, not an empty wallet', () => {
    for (const sub of [170, 171, 196]) {
        assert.equal(isStaleDustProof(reject(sub)), true, `sub-code ${sub}`);
        assert.equal(isFundsProblem(reject(sub)), false, `sub-code ${sub} must not read as funds`);
    }
});

test('196 classifies as a stale dust proof', () => {
    // Named separately because the branch turns on it: read as anything else,
    // the engine would not re-gate and re-prove, and the stage would fail on a
    // wallet that can pay perfectly well.
    assert.equal(classifyNodeReject(reject(196)).kind, 'stale-dust-proof');
    assert.equal(classifyNodeReject(reject(196)).subCode, 196);
});

test('only 138 and 173 mean the wallet cannot pay', () => {
    for (const sub of [138, 173]) assert.equal(isFundsProblem(reject(sub)), true, `sub-code ${sub}`);
    for (const sub of [170, 171, 196, 117, 219, 224]) {
        assert.equal(isFundsProblem(reject(sub)), false, `sub-code ${sub} must not read as funds`);
    }
});

test('the balancer\'s own wording still reads as funds', () => {
    assert.equal(isFundsProblem('Insufficient Funds: could not balance dust'), true);
    assert.equal(isFundsProblem('InvalidTransaction::Payment'), true, 'our own extra pattern survives');
});

test('the sequencing band is the only thing worth splitting a batch for', () => {
    for (let sub = 219; sub <= 224; sub++) assert.equal(isSequencingProblem(reject(sub)), true, `sub-code ${sub}`);
    assert.equal(isSequencingProblem(reject(188)), true, 'the retired code still classifies');
    assert.equal(isSequencingProblem(reject(170)), false);
    assert.equal(isSequencingProblem('BatchCausalityViolation'), true);
    assert.equal(isSequencingProblem('bad segment ordering'), true, 'our own extra pattern survives');
});

test('117 NotNormalized is malformed - neither waiting nor a rebuild helps', () => {
    assert.equal(classifyNodeReject(reject(117)).kind, 'malformed');
    assert.equal(isStaleDustProof(reject(117)), false);
    assert.equal(isFundsProblem(reject(117)), false);
    assert.equal(isSequencingProblem(reject(117)), false);
});

test('a source position can never be mistaken for a sub-code', () => {
    assert.equal(classifyNodeReject('at foo.mjs:170:171 something broke').kind, 'unknown');
});

test('the sub-code is found through a cause chain, not just one message', () => {
    const inner = new Error(reject(171));
    const outer = new Error('stage 3 failed', { cause: inner });
    assert.equal(isStaleDustProof(outer), true);
});

// -------------------------------------------------- revert / probe decision

test('only a pre-mempool reject licenses reverting the dust spend', () => {
    // The engine reverts on this and nothing else. A revert on anything wider
    // can undo a spend that really happened.
    assert.equal(isPreMempoolReject(new Error('node rejected: 1010 Invalid Transaction')), true);
    assert.equal(isPreMempoolReject(new Error('node rejected: 1014 Priority is too low')), true);
    assert.equal(isPreMempoolReject(new Error('node rejected: 1016 Immediately Dropped')), true);

    assert.equal(isPreMempoolReject(new Error('node rejected: 1013 Transaction Already Imported')), false,
        '1013 means it IS in the pool');
    assert.equal(isPreMempoolReject(new Error('disconnected from wss://node: 1000:: Normal Closure')), false,
        'a lost socket says nothing about the mempool');
});

test('a lost socket reads as transport, and 1013 as already imported', () => {
    assert.equal(isTransportFailure(new Error('disconnected from wss://node: 1000:: Normal Closure')), true);
    assert.equal(isTransportFailure(new Error('submit timed out after 30000ms')), true);
    assert.equal(isTransportFailure(new Error('node rejected: 1010 Invalid Transaction')), false,
        'a real reject is not transport');
    assert.equal(isAlreadyImported(new Error('node rejected: 1013 Transaction Already Imported')), true);
});

// ------------------------------------------------------------ submit socket

/** Minimal stand-in for `ws`: the script says what the socket does. */
function fakeSocket(script) {
    return class {
        constructor(url) {
            this.url = url;
            this.sent = [];
            queueMicrotask(() => this.onopen?.({}));
        }
        send(payload) {
            this.sent.push(payload);
            script(this, JSON.parse(payload));
        }
        close() { this.closed = true; }
    };
}

test('a clean reply resolves with the extrinsic hash', async () => {
    const Ws = fakeSocket((ws, msg) => {
        assert.equal(msg.method, 'author_submitExtrinsic');
        assert.deepEqual(msg.params, ['0xdeadbeef']);
        ws.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: '0xabc123' }) });
    });
    const hash = await submitExtrinsic('0xdeadbeef', { nodeUrl: 'wss://node/', WebSocketImpl: Ws });
    assert.equal(hash, '0xabc123');
});

test('a close before the reply fails AT ONCE, not after the timeout', async () => {
    // The gateway's own 1000 Normal Closure has to end the wait immediately.
    // Without an onclose the promise stays pending until the 30s timer, which
    // is a whole stage's slack spent learning nothing.
    const Ws = fakeSocket((ws) => ws.onclose({ code: 1000, reason: 'Normal Closure' }));
    const started = Date.now();
    const err = await submitExtrinsic('0xdeadbeef', {
        nodeUrl: 'wss://node/', timeoutMs: 30_000, WebSocketImpl: Ws
    }).then(() => null, (e) => e);

    assert.ok(err, 'must reject');
    assert.ok(Date.now() - started < 2_000, `failed in ${Date.now() - started}ms, must not wait out the timeout`);
    assert.equal(err.transport, true, 'a close is transport, not a reject');
    assert.equal(isTransportFailure(err), true);
    assert.equal(isPreMempoolReject(err), false, 'must NOT license a dust revert');
    assert.match(err.message, /probe the indexer/i, 'the message has to say what to do next');
});

test('a node reject carries its code and the ledger sub-code on the error', async () => {
    const data = { Module: { error: 'Custom error: 171' } };
    const Ws = fakeSocket((ws, msg) => ws.onmessage({
        data: JSON.stringify({ id: msg.id, error: { code: 1010, message: 'Invalid Transaction', data } })
    }));
    const err = await submitExtrinsic('0x00', { nodeUrl: 'wss://node/', WebSocketImpl: Ws })
        .then(() => null, (e) => e);

    assert.equal(err.code, 1010, 'structured, not only in the message');
    assert.deepEqual(err.data, data);
    assert.equal(err.transport, undefined, 'a reject is not transport');
    assert.equal(isStaleDustProof(err), true, 'the sub-code survives into the classifier');
    assert.equal(isPreMempoolReject(err), true, 'and a 1010 does license the revert');
});

test('a socket that answers twice settles once', async () => {
    const reply = (id, result) => JSON.stringify({ id, result });
    const Ws = fakeSocket((ws, msg) => {
        ws.onmessage({ data: reply(msg.id, '0xfirst') });
        ws.onmessage({ data: reply(msg.id, '0xsecond') });
        ws.onclose({ code: 1000, reason: 'Normal Closure' });
    });
    assert.equal(await submitExtrinsic('0x00', { nodeUrl: 'wss://node/', WebSocketImpl: Ws }), '0xfirst');
});

test('a non-JSON frame is ignored, not fatal', async () => {
    const Ws = fakeSocket((ws, msg) => {
        ws.onmessage({ data: '<html>gateway noise</html>' });
        ws.onmessage({ data: JSON.stringify({ id: msg.id, result: '0xok' }) });
    });
    assert.equal(await submitExtrinsic('0x00', { nodeUrl: 'wss://node/', WebSocketImpl: Ws }), '0xok');
});

test('a reply for another id is ignored', async () => {
    const Ws = fakeSocket((ws, msg) => {
        ws.onmessage({ data: JSON.stringify({ id: msg.id + 99, result: '0xwrong' }) });
        ws.onmessage({ data: JSON.stringify({ id: msg.id, result: '0xright' }) });
    });
    assert.equal(await submitExtrinsic('0x00', { nodeUrl: 'wss://node/', WebSocketImpl: Ws }), '0xright');
});

test('the timeout still bounds a socket that neither replies nor closes', async () => {
    const Ws = fakeSocket(() => { /* silence */ });
    const err = await submitExtrinsic('0x00', { nodeUrl: 'wss://node/', timeoutMs: 120, WebSocketImpl: Ws })
        .then(() => null, (e) => e);
    assert.equal(err.transport, true);
    assert.match(err.message, /timed out/i);
});

test('submitExtrinsic refuses to run without a node url', () => {
    assert.throws(() => submitExtrinsic('0x00', {}), /nodeUrl is required/);
});
