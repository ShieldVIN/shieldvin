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
 * from private state — including which vehicle is being operated on. A real
 * holder's wallet does the same thing: it stages the values for the call it is
 * about to make, then makes it.
 *
 *   store    vinHex -> { reading, salt }   what this holder knows
 *   pending  { vinHex, reading, salt }     staged for the call in flight
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
import {
    Contract,
    ledger
} from '../contracts/shieldvin-passport/src/managed/shieldvin-passport/contract/index.js';

export const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** A deterministic 32-byte value, so a failure is reproducible. */
export const bytes32 = (fill) => new Uint8Array(32).fill(fill);

/**
 * The witnesses. Each reads what the simulator staged in `pending`, or what it
 * recorded for this vehicle in `store`.
 *
 * `previousReading` and `previousSalt` fall back to zero rather than throwing
 * when nothing is known, on purpose: a caller who does not know the previous
 * reading must be stopped by the CIRCUIT — that is what the commitment-opening
 * assert is for — and not by a helpful local error that would mask its absence.
 */
export const witnesses = {
    newReading: (ctx) => [ctx.privateState, ctx.privateState.pending.reading],
    newSalt: (ctx) => [ctx.privateState, ctx.privateState.pending.salt],
    previousReading: (ctx) => [
        ctx.privateState,
        ctx.privateState.store[ctx.privateState.pending.vinHex]?.reading ?? 0n
    ],
    previousSalt: (ctx) => [
        ctx.privateState,
        ctx.privateState.store[ctx.privateState.pending.vinHex]?.salt ?? bytes32(0)
    ]
};

export class PassportSimulator {
    constructor() {
        this.contract = new Contract(witnesses);
        const initial = { store: {}, pending: { vinHex: null, reading: 0n, salt: bytes32(0) } };
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

    /** Stage the values the witnesses will hand to the next call. */
    stage(vin, reading, salt) {
        this.ctx.currentPrivateState.pending = { vinHex: hex(vin), reading, salt };
    }

    /** Advance the holder's own record — only after the circuit accepted. */
    commit(vin, reading, salt) {
        this.ctx.currentPrivateState.store[hex(vin)] = { reading, salt };
    }

    registerPassport(vin, contentRoot, registrarId) {
        this.ctx = this.contract.impureCircuits.registerPassport(
            this.ctx, vin, contentRoot, registrarId
        ).context;
        return this.ledger;
    }

    initialiseOdometer(vin, reading, salt) {
        this.stage(vin, reading, salt);
        this.ctx = this.contract.impureCircuits.initialiseOdometer(this.ctx, vin).context;
        this.commit(vin, reading, salt);
        return this.ledger;
    }

    /**
     * Record a subsequent reading.
     *
     * `openWith` overrides what the caller claims the PREVIOUS reading and salt
     * were, which is how the tests impersonate someone who does not actually
     * know them. Omitted, the simulator opens with what it genuinely recorded.
     */
    recordReading(vin, reading, salt, openWith) {
        const known = this.privateState.store[hex(vin)];
        const restore = known ? { ...known } : undefined;
        if (openWith) this.ctx.currentPrivateState.store[hex(vin)] = openWith;
        this.stage(vin, reading, salt);
        try {
            this.ctx = this.contract.impureCircuits.recordReading(this.ctx, vin).context;
        } finally {
            // A forged opening must never be left behind as if it were real,
            // whether the call was accepted or rejected.
            if (openWith && restore) this.ctx.currentPrivateState.store[hex(vin)] = restore;
        }
        this.commit(vin, reading, salt);
        return this.ledger;
    }

    /**
     * Prove the current reading is at or below `bound`, disclosing neither the
     * reading nor its salt. Opens the stored commitment with what the holder
     * knows, unless `openWith` supplies a different claim.
     */
    proveOdometerBelow(vin, bound, openWith) {
        const known = this.privateState.store[hex(vin)];
        const restore = known ? { ...known } : undefined;
        if (openWith) this.ctx.currentPrivateState.store[hex(vin)] = openWith;
        this.ctx.currentPrivateState.pending = {
            vinHex: hex(vin), reading: 0n, salt: bytes32(0)
        };
        try {
            this.ctx = this.contract.impureCircuits.proveOdometerBelow(
                this.ctx, vin, bound
            ).context;
        } finally {
            if (openWith && restore) this.ctx.currentPrivateState.store[hex(vin)] = restore;
        }
        return this.ledger;
    }

    /**
     * Every value the public ledger holds, collected by KIND rather than
     * flattened to text.
     *
     * The privacy tests use this to assert that a reading never reaches the
     * ledger. Structure matters here: an earlier version of this searched a
     * concatenated hex dump for the reading's hex digits, which is unsound —
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
        walk(l.odometerCommitment);
        walk(l.registrar);
        walk(l.readingCount);
        return { words, blobs };
    }
}
