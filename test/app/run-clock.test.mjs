/**
 * The run page's clock must only ever move forwards.
 *
 * The page corrects for a viewer whose own clock is wrong, using a server
 * time. Which server time it uses is the whole question: a job's `updatedAt`
 * is when the job last CHANGED, and a stage sits inside a single proof for
 * tens of seconds without changing anything. Read as "now", it falls further
 * behind on every poll, and each poll then drags the displayed elapsed time
 * backwards while the one-second ticker walks it forwards - a clock that
 * repeats a number several times before moving on.
 *
 * The response `Date` header is a real server now, so that is what the page
 * uses. These cases model both sources against the same timeline and assert
 * the property that matters: monotonic, and roughly truthful.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The page's clock, with the skew source injected so both the old and the new
 * behaviour can be driven over one timeline.
 */
function makeClock() {
    let skewMs = 0;
    return {
        note: (serverNowMs, viewerNowMs) => { skewMs = viewerNowMs - serverNowMs; },
        read: (viewerNowMs, sinceMs) => Math.max(0, (viewerNowMs - skewMs) - sinceMs)
    };
}

/**
 * A stage that starts at server t=0 and proves for 60s without touching the
 * job, polled every 3s, ticking every 1s. The viewer's own clock is 45s fast,
 * which is the whole reason a correction exists.
 */
function timeline(skewSource) {
    const VIEWER_OFFSET = 45_000;
    const PROOF_MS = 60_000;
    const startedAt = 0;              // server time the step began
    const updatedAt = 0;              // job last touched when the step began
    const clock = makeClock();
    const shown = [];

    for (let serverT = 0; serverT <= PROOF_MS; serverT += 1000) {
        const viewerT = serverT + VIEWER_OFFSET;
        if (serverT % 3000 === 0) {
            // A poll lands: the page takes its correction from one source or
            // the other. `date` is a true server now; `updatedAt` is stale.
            clock.note(skewSource === 'date' ? serverT : updatedAt, viewerT);
        }
        shown.push(clock.read(viewerT, startedAt));
    }
    return shown;
}

test('the Date header keeps the clock monotonic through a long proof', () => {
    const shown = timeline('date');
    for (let i = 1; i < shown.length; i++) {
        assert.ok(shown[i] >= shown[i - 1],
            `went backwards at ${i}s: ${shown[i - 1]} -> ${shown[i]}`);
    }
});

test('the Date header keeps the clock truthful, not merely rising', () => {
    const shown = timeline('date');
    // Every reading is the real elapsed time, to within the poll interval.
    for (let i = 0; i < shown.length; i++) {
        assert.ok(Math.abs(shown[i] - i * 1000) <= 3000,
            `at ${i}s the clock said ${shown[i]}ms`);
    }
    assert.ok(shown.at(-1) >= 57_000, `after a 60s proof the clock said ${shown.at(-1)}ms`);
});

test('updatedAt as a clock source cannot track a long step', () => {
    // Kept as the contrast case: it is what the page used to do, and it is
    // what any future change back to a payload timestamp would reintroduce.
    const shown = timeline('updatedAt');

    // It goes backwards: the ticker walks forward for three seconds, then a
    // poll recomputes the skew against a stamp that has not moved and yanks
    // it back to where it started.
    assert.ok(shown.some((v, i) => i > 0 && v < shown[i - 1]),
        'the stale source is expected to go backwards');

    // The consequence, and the reason it is visible to a viewer: over a full
    // 60s proof the clock never gets past one poll interval.
    assert.ok(Math.max(...shown) <= 3_000,
        `it reached ${Math.max(...shown)}ms; if it now tracks, the source changed`);
    assert.ok(shown.at(-1) < 5_000, `after a 60s proof it said ${shown.at(-1)}ms`);
});

test('a step stamped in the future never shows a negative elapsed', () => {
    // Reachable whenever the correction lags the stamp it is compared against:
    // the Date header is whole-second and is written before the reply travels,
    // so a step stamped moments later can sit ahead of the corrected now.
    const clock = makeClock();
    clock.note(100_000, 40_000);          // viewer is a minute BEHIND the server
    // corrected now = 101_000; a step stamped at 102_000 has not begun yet.
    assert.equal(clock.read(41_000, 102_000), 0, 'must clamp at zero, not go negative');
    // And a step that HAS begun still reports its real age.
    assert.equal(clock.read(41_000, 100_500), 500);
});

test('with no server time at all the clock still runs on the viewer\'s own', () => {
    // The Date header is unreadable cross-origin unless the API exposes it.
    // If an older API ever answers without it, the clock must degrade to the
    // viewer's own time rather than freezing.
    const clock = makeClock();
    const a = clock.read(10_000, 0);
    const b = clock.read(20_000, 0);
    assert.equal(a, 10_000);
    assert.ok(b > a, 'must keep running with no correction');
});
