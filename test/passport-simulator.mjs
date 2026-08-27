/**
 * A local simulator for the `shieldvin-passport` contract.
 *
 * The contract runs here exactly as it runs on chain — same compiled circuits,
 * same ledger semantics, same assertions — but against an in-memory ledger and
 * with proving switched off. That makes the privacy properties testable: the
 * whole public ledger can be inspected after every call, so the tests can check
 * what did NOT reach it.
 *
 * WHY THE PRIVATE STATE LOOKS LIKE THIS
 *
 * The four witnesses take no arguments. They are the boundary between the
 * caller's private world and the circuit, so everything they return has to come
 * from private state — including which vehicle and which field is being
 * operated on. A real holder's wallet does the same thing: it stages the values
 * for the call it is about to make, then makes it.
 *
 *   store    "vinHex/fieldHex" -> { value, salt }   what this holder knows
 *   pending  { slot, value, salt }                  staged for the call in flight
 *
 * Witnesses here are pure readers. `store` is only advanced after a circuit
 * returns successfully, mirroring a wallet that commits private state once the
 * transaction is accepted — which matters for the tests, because a rejected
 * call must leave the holder's record untouched.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    createConstructorContext,
    createCircuitContext,
    sampleContractAddress
} from '@midnight-ntwrk/compact-runtime';
import { blake2b } from '@noble/hashes/blake2';
import {
    Contract,
    Rule,
    ledger
} from '../contracts/shieldvin-passport/src/managed/shieldvin-passport/contract/index.js';

export { Rule };

export const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** A deterministic 32-byte value, so a failure is reproducible. */
export const bytes32 = (fill) => new Uint8Array(32).fill(fill);

/**
 * The public label of a field, exactly as `@odatano/dpp-sdk` derives it:
 * blake2b-256 of the field name. Using the real derivation rather than an
 * invented one keeps these tests honest about the keys the product will
 * actually use.
 */
export const fieldKey = (name) =>
    blake2b(new TextEncoder().encode(name), { dkLen: 32 });

/**
 * The fields these tests exercise, with the rule each is created under.
 *
 * Every field the panel actually uses today only ever rises. `reservedNumeric0`
 * stands in for a field that may only fall — the contract supports the
 * direction so that adding such a field later is a data change rather than a
 * contract change, and the tests have to prove that support is real.
 */
export const FIELDS = {
    odometerKm:       Rule.neverFalls,
    accidentCount:    Rule.neverFalls,
    ownerCount:       Rule.neverFalls,
    writeOffCategory: Rule.neverFalls,
    reservedNumeric0: Rule.neverRises
};

/**
 * The witnesses. Each reads what the simulator staged in `pending`, or what it
 * recorded for this vehicle-and-field in `store`.
 *
 * `previousValue` and `previousSalt` fall back to zero rather than throwing
 * when nothing is known, on purpose: a caller who does not know the current
 * value must be stopped by the CIRCUIT — that is what the commitment-opening
 * assert is for — and not by a helpful local error that would mask its absence.
 */
export const witnesses = {
    newValue: (ctx) => [ctx.privateState, ctx.privateState.pending.value],
    newSalt: (ctx) => [ctx.privateState, ctx.privateState.pending.salt],
    previousValue: (ctx) => [
        ctx.privateState,
        ctx.privateState.store[ctx.privateState.pending.slot]?.value ?? 0n
    ],
    previousSalt: (ctx) => [
        ctx.privateState,
        ctx.privateState.store[ctx.privateState.pending.slot]?.salt ?? bytes32(0)
    ]
};

export class PassportSimulator {
    constructor() {
        this.contract = new Contract(witnesses);
        const initial = { store: {}, pending: { slot: null, value: 0n, salt: bytes32(0) } };
        const init = this.contract.initialState(
            createConstructorContext(initial, '0'.repeat(64))
        );
        this.ctx = createCircuitContext(
            sampleContractAddress(),
            '0'.repeat(64),
            init.currentContractState,
            init.currentPrivateState
        );
    }

    /** The public ledger, as any observer of the chain would read it. */
    get ledger() {
        return ledger(this.ctx.currentQueryContext.state);
    }

    get privateState() {
        return this.ctx.currentPrivateState;
    }

    /**
     * The holder's own index into private state.
     *
     * NOTE this is NOT the contract's slot key. The contract derives its slot
     * with a domain-separated `persistentHash` inside the circuit; this is just
     * how the simulator's wallet files what it knows. Keeping them separate is
     * deliberate — if the test harness recomputed the contract's key it would
     * be asserting its own arithmetic rather than the contract's.
     */
    ref(vin, field) {
        return `${hex(vin)}/${hex(field)}`;
    }

    stage(vin, field, value, salt) {
        this.ctx.currentPrivateState.pending = { slot: this.ref(vin, field), value, salt };
    }

    commit(vin, field, value, salt) {
        this.ctx.currentPrivateState.store[this.ref(vin, field)] = { value, salt };
    }

    registerPassport(vin, contentRoot, registrarId) {
        this.ctx = this.contract.impureCircuits.registerPassport(
            this.ctx, vin, contentRoot, registrarId
        ).context;
        return this.ledger;
    }

    initialiseField(vin, field, rule, value, salt) {
        this.stage(vin, field, value, salt);
        this.ctx = this.contract.impureCircuits.initialiseField(
            this.ctx, vin, field, rule
        ).context;
        this.commit(vin, field, value, salt);
        return this.ledger;
    }

    /**
     * Write a new value.
     *
     * `openWith` overrides what the caller claims the CURRENT value and salt
     * were, which is how the tests impersonate someone who does not actually
     * know them. Omitted, the simulator opens with what it genuinely recorded.
     */
    recordField(vin, field, value, salt, openWith) {
        const ref = this.ref(vin, field);
        const known = this.privateState.store[ref];
        const restore = known ? { ...known } : undefined;
        if (openWith) this.ctx.currentPrivateState.store[ref] = openWith;
        this.stage(vin, field, value, salt);
        try {
            this.ctx = this.contract.impureCircuits.recordField(this.ctx, vin, field).context;
        } finally {
            // A forged opening must never be left behind as if it were real,
            // whether the call was accepted or rejected.
            if (openWith && restore) this.ctx.currentPrivateState.store[ref] = restore;
        }
        this.commit(vin, field, value, salt);
        return this.ledger;
    }

    #prove(name, vin, field, bound, openWith) {
        const ref = this.ref(vin, field);
        const known = this.privateState.store[ref];
        const restore = known ? { ...known } : undefined;
        if (openWith) this.ctx.currentPrivateState.store[ref] = openWith;
        this.ctx.currentPrivateState.pending = { slot: ref, value: 0n, salt: bytes32(0) };
        try {
            this.ctx = this.contract.impureCircuits[name](this.ctx, vin, field, bound).context;
        } finally {
            if (openWith && restore) this.ctx.currentPrivateState.store[ref] = restore;
        }
        return this.ledger;
    }

    /** Prove the hidden value is at or below `bound`, disclosing neither. */
    proveFieldAtMost(vin, field, bound, openWith) {
        return this.#prove('proveFieldAtMost', vin, field, bound, openWith);
    }

    /** Prove the hidden value is at or above `bound`, disclosing neither. */
    proveFieldAtLeast(vin, field, bound, openWith) {
        return this.#prove('proveFieldAtLeast', vin, field, bound, openWith);
    }

    /**
     * Every value the public ledger holds, collected by KIND rather than
     * flattened to text.
     *
     * The privacy tests use this to assert that a field value never reaches the
     * ledger. Structure matters here: an earlier version of this searched a
     * concatenated hex dump for the value's hex digits, which is unsound —
     * `12345` is `3039`, and four hex characters turn up inside a random
     * 32-byte commitment often enough to make the test flap in both directions.
     * Comparing whole values instead means a pass means what it says.
     *
     *   words  every bigint on the ledger
     *   blobs  every byte string, as hex
     */
    ledgerValues() {
        const words = [];
        const blobs = [];
        const walk = (value) => {
            if (value === null || value === undefined) return;
            if (value instanceof Uint8Array) { blobs.push(hex(value)); return; }
            if (typeof value === 'bigint') { words.push(value); return; }
            if (typeof value === 'string') { blobs.push(value); return; }
            if (typeof value === 'number') { words.push(BigInt(value)); return; }
            if (typeof value[Symbol.iterator] === 'function') {
                for (const item of value) walk(item);
                return;
            }
            if (typeof value === 'object') for (const v of Object.values(value)) walk(v);
        };
        const l = this.ledger;
        walk(l.passports);
        walk(l.registrar);
        walk(l.fieldCommitment);
        walk(l.fieldRule);
        walk(l.claims);
        walk(l.updateCount);
        return { words, blobs };
    }
}
