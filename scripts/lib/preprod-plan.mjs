/**
 * How an intake becomes transactions, and how a call's private state is armed.
 *
 * Kept apart from preprod-runner.mjs, which pulls in the whole wallet SDK, so
 * these two rules can be tested in milliseconds without a chain, a wallet or
 * a proof. Both were learned from rejected transactions rather than from a
 * type signature, which is exactly why they live somewhere testable.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { webcrypto } from 'node:crypto';

/**
 * Circuits that write a cell the ledger already holds.
 *
 * The ledger's sequencing check refuses a call that updates an
 * already-populated cell when any later intent follows it in the same
 * transaction (the node reports it as a bare 1010/188). Reading the contract:
 *
 *   registerPassport   inserts a fresh vinHash into passports + registrar
 *   initialiseField    inserts a fresh slot, then updateCount.increment()
 *   recordField        OVERWRITES the slot, then updateCount.increment()
 *   proveFieldAtMost   inserts a fresh claimKey into claims
 *
 * updateCount is a Counter - one cell, always populated - so initialiseField
 * and recordField are the cell-updating pair. Registration and the proof
 * circuits touch nothing that already exists, which is why "anchor first,
 * then proofs" is the shape that batches.
 */
export const CELL_UPDATING = new Set(['initialiseField', 'recordField']);

export const MAX_CALLS_PER_TX = 8;      // nightgate-tx batch ceiling
export const MAX_CALLS_PER_RUN = 12;    // bounds a run's wall clock

/** The claims a console can request, mapped onto circuit calls. */
export const CLAIM_DEFS = {
    neverWrittenOff: { field: 'writeOffCategory', bound: () => 0n, label: 'Never written off' },
    noAccidents: { field: 'accidentCount', bound: () => 0n, label: 'No reported accidents' },
    oneKeeper: { field: 'ownerCount', bound: () => 1n, label: 'One keeper' },
    mileageUnder: { field: 'odometerKm', bound: (v) => BigInt(v), label: 'Mileage under' }
};

// Random demo VIN: real 17-char shape, VPD prefix marks it as a demo unit.
const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'; // no I/O/Q
export const randomDemoVin = () => {
    const u = new Uint8Array(14);
    webcrypto.getRandomValues(u);
    return 'VPD' + Array.from(u, (b) => VIN_ALPHABET[b % VIN_ALPHABET.length]).join('');
};

export const stepLabel = (s) =>
    s.kind === 'register' ? 'registerPassport'
        : s.kind === 'init' ? `initialiseField ${s.name}`
            : s.kind === 'update' ? `update ${s.round}: ${s.name} -> ${s.value}`
                : `prove ${s.claim}${s.claim === 'mileageUnder' ? ' ' + s.bound : ''}`;

export const makeStage = (steps) => ({
    label: steps.length === 1 ? stepLabel(steps[0])
        : `${steps.length} calls: ${steps.map(stepLabel).join(' + ')}`,
    steps
});

/**
 * The calls an intake needs, in dependency order, packed into as few
 * transactions as the sequencing rule allows: a transaction accumulates
 * freely-batchable calls and is closed by the first cell-updating call it
 * meets. Apply order inside a transaction is call order (nightgate-tx sorts
 * the randomized segment ids ascending before proving), so a batch may carry
 * dependent calls - a registration and the initialisation that needs it.
 *
 * One batch here holds several identically-named calls: the claims. The
 * builder cannot tell same-named intents apart, so their relative apply order
 * is not guaranteed - which is fine precisely because claims are independent.
 * Each opens its own field's commitment and inserts its own fresh claimKey,
 * so no claim can observe another. Never batch same-named calls that DO
 * depend on each other; give them their own transactions instead.
 */
export function planCalls(intake) {
    const steps = [{ kind: 'register', circuit: 'registerPassport' }];
    for (const [name, value] of Object.entries(intake.fields ?? {})) {
        steps.push({ kind: 'init', circuit: 'initialiseField', name, value: BigInt(value) });
    }
    (intake.updates ?? []).forEach((round, i) => {
        for (const [name, value] of Object.entries(round)) {
            steps.push({ kind: 'update', circuit: 'recordField', name, value: BigInt(value), round: i + 1 });
        }
    });
    for (const [claim, def] of Object.entries(CLAIM_DEFS)) {
        const wanted = claim === 'mileageUnder' ? intake.prove?.mileageUnder : intake.prove?.[claim];
        if (wanted) steps.push({ kind: 'claim', circuit: 'proveFieldAtMost', claim, name: def.field, bound: def.bound(wanted) });
    }
    if (steps.length > MAX_CALLS_PER_RUN) {
        throw Object.assign(
            new Error(`intake needs ${steps.length} on-chain calls; the demo caps at ${MAX_CALLS_PER_RUN} - fewer fields, updates or claims, please`),
            { code: 'TOO_LARGE' });
    }

    const stages = [];
    let cur = [];
    const close = () => { if (cur.length) { stages.push(makeStage(cur)); cur = []; } };
    for (const s of steps) {
        cur.push(s);
        if (CELL_UPDATING.has(s.circuit) || cur.length >= MAX_CALLS_PER_TX) close();
    }
    close();
    return stages;
}

const zero32 = () => new Uint8Array(32);

/**
 * The shared witness holder, and the only sanctioned way to fill it.
 *
 * ARMING IS NOT OPTIONAL. nightgate-tx runs per-call `before` hooks only for
 * a BATCH; a single call is proven with the witnesses exactly as they stand.
 * An unarmed holder would read as value 0 with a zero salt - and because
 * initialiseField asserts nothing about prior state, that PROVES and LANDS,
 * writing a commitment nobody can ever open. The damage only surfaces later,
 * when recordField or a claim tries to open it.
 *
 * So the holder refuses to be read until a hook has armed it for the call in
 * flight. A missed arming is a loud build error instead of a quiet zero on
 * the public chain.
 */
export function makeWitnessHolder() {
    const holder = { pending: { value: 0n, salt: zero32() }, prev: { value: 0n, salt: zero32() }, armed: null };
    const armedRead = (what, pick) => (ctx) => {
        if (!holder.armed) {
            throw new Error(`witness ${what}() was read before any call armed it; refusing to prove a zero value`);
        }
        return [ctx.privateState, pick()];
    };
    return {
        holder,
        witnesses: {
            newValue: armedRead('newValue', () => holder.pending.value),
            newSalt: armedRead('newSalt', () => holder.pending.salt),
            previousValue: armedRead('previousValue', () => holder.prev.value),
            previousSalt: armedRead('previousSalt', () => holder.prev.salt)
        },
        arm: (label, state) => () => {
            holder.pending = state.pending ?? { value: 0n, salt: zero32() };
            holder.prev = state.prev ?? { value: 0n, salt: zero32() };
            holder.armed = label;
        }
    };
}
