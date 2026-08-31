/**
 * The preprod runner's PLANNING and WITNESS-ARMING rules, tested offline.
 *
 * Both rules cost a real transaction to learn and neither is visible in a
 * type signature, so they are pinned here rather than in a comment:
 *
 *  1. Packing. The ledger refuses a call that updates an already-populated
 *     cell when a later intent follows it in the same transaction, so a
 *     cell-updating call (initialiseField and recordField both bump the
 *     updateCount counter) must be LAST in its transaction.
 *
 *  2. Arming. nightgate-tx runs per-call `before` hooks only for a BATCH; a
 *     single call is proven with the witnesses exactly as they stand. An
 *     unarmed holder reads as value 0 with a zero salt, and initialiseField
 *     asserts nothing about prior state - so it would prove, land, and write
 *     a commitment nobody can ever open. The holder must refuse to be read
 *     until a hook arms it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCalls, CELL_UPDATING, makeWitnessHolder } from '../../scripts/lib/preprod-plan.mjs';

const kinds = (plan) => plan.map((st) => st.steps.map((s) => s.kind));

test('a cell-updating call is always last in its transaction', () => {
    const plan = planCalls({
        fields: { odometerKm: 10, accidentCount: 0, ownerCount: 1 },
        updates: [{ odometerKm: 20 }],
        prove: { noAccidents: true, mileageUnder: 100 }
    });
    for (const stage of plan) {
        const updating = stage.steps.filter((s) => CELL_UPDATING.has(s.circuit));
        assert.ok(updating.length <= 1, 'at most one cell-updating call per transaction');
        if (updating.length === 1) {
            assert.equal(stage.steps[stage.steps.length - 1], updating[0],
                'the cell-updating call must be the last one in the transaction');
        }
    }
});

test('the register rides with the first initialisation, and claims batch together', () => {
    const plan = planCalls({
        fields: { odometerKm: 10, accidentCount: 0, ownerCount: 1 },
        updates: [{ odometerKm: 20 }],
        prove: { noAccidents: true, mileageUnder: 100 }
    });
    assert.deepEqual(kinds(plan), [
        ['register', 'init'],   // register inserts fresh cells; the init closes the tx
        ['init'],
        ['init'],
        ['update'],
        ['claim', 'claim']      // claims touch no populated cell, so they ride together
    ]);
});

test('a claims-only intake is a single transaction', () => {
    const plan = planCalls({ fields: {}, prove: { noAccidents: true, neverWrittenOff: true, oneKeeper: true, mileageUnder: 9 } });
    assert.equal(plan.length, 1, 'four claims and a register fit one transaction');
    assert.equal(plan[0].steps.length, 5);
});

test('the witness holder refuses to be read before a call arms it', () => {
    const { witnesses, arm, holder } = makeWitnessHolder();
    const ctx = { privateState: {} };

    assert.throws(() => witnesses.newValue(ctx), /before any call armed it/,
        'an unarmed read must fail loudly rather than return a zero value');

    arm('initialiseField odometerKm', { pending: { value: 42n, salt: new Uint8Array(32).fill(7) } })();
    assert.equal(witnesses.newValue(ctx)[1], 42n);
    assert.equal(witnesses.newSalt(ctx)[1][0], 7);
    assert.equal(holder.armed, 'initialiseField odometerKm');

    holder.armed = null;
    assert.throws(() => witnesses.newSalt(ctx), /before any call armed it/,
        'disarming between transactions must re-arm the guard');
});
