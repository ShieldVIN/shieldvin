/**
 * Contract tests for `shieldvin-passport`.
 *
 * These run the COMPILED circuits against a local ledger, so an assertion that
 * fires here is the same assertion that would reject the transaction on chain.
 *
 * The suite is organised around one question per circuit — does it do the thing
 * — followed by the two that actually matter for a vehicle passport:
 *
 *   ROLLBACK   can a holder lower a reading they have already committed to?
 *   DISCLOSURE does the reading ever reach the public ledger?
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PassportSimulator, bytes32, hex } from './passport-simulator.mjs';

// One vehicle, and a second for the isolation tests.
const VIN_A = bytes32(0x11);
const VIN_B = bytes32(0x22);
const ROOT = bytes32(0xaa);
const ROOT_B = bytes32(0xbb);
const REGISTRAR = bytes32(0x77);

const SALT_1 = bytes32(0xd1);
const SALT_2 = bytes32(0xd2);
const SALT_3 = bytes32(0xd3);
const WRONG_SALT = bytes32(0xee);

/** A Compact `assert` failure, as the runtime surfaces it. */
const rejects = (message) => new RegExp(`failed assert: ${message}`);

let sim;
beforeEach(() => {
    sim = new PassportSimulator();
});

// ---------------------------------------------------------------- registration

describe('registerPassport', () => {
    it('anchors the content root and the registrar against the VIN hash', () => {
        const l = sim.registerPassport(VIN_A, ROOT, REGISTRAR);

        expect(l.passports.member(VIN_A)).toBe(true);
        expect(hex(l.passports.lookup(VIN_A))).toBe(hex(ROOT));
        expect(hex(l.registrar.lookup(VIN_A))).toBe(hex(REGISTRAR));
    });

    it('does not touch the odometer, which is a separate act', () => {
        const l = sim.registerPassport(VIN_A, ROOT, REGISTRAR);

        expect(l.odometerCommitment.member(VIN_A)).toBe(false);
        expect(l.readingCount).toBe(0n);
    });

    it('refuses to re-register a VIN, so a passport cannot be overwritten', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);

        expect(() => sim.registerPassport(VIN_A, ROOT_B, REGISTRAR))
            .toThrow(rejects('passport already registered'));
    });

    it('keeps the first content root after a rejected re-registration', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        try { sim.registerPassport(VIN_A, ROOT_B, REGISTRAR); } catch { /* expected */ }

        expect(hex(sim.ledger.passports.lookup(VIN_A))).toBe(hex(ROOT));
    });

    it('keeps vehicles independent', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        const l = sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);

        expect(l.passports.size()).toBe(2n);
        expect(hex(l.passports.lookup(VIN_A))).toBe(hex(ROOT));
        expect(hex(l.passports.lookup(VIN_B))).toBe(hex(ROOT_B));
    });
});

// ------------------------------------------------------------------- odometer

describe('initialiseOdometer', () => {
    it('will not initialise an odometer for a vehicle that has no passport', () => {
        expect(() => sim.initialiseOdometer(VIN_A, 12_000n, SALT_1))
            .toThrow(rejects('unknown passport'));
    });

    it('stores a commitment and counts the reading', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        const l = sim.initialiseOdometer(VIN_A, 12_000n, SALT_1);

        expect(l.odometerCommitment.member(VIN_A)).toBe(true);
        expect(l.readingCount).toBe(1n);
    });

    it('stores a commitment, not the reading', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        const l = sim.initialiseOdometer(VIN_A, 12_000n, SALT_1);
        const stored = hex(l.odometerCommitment.lookup(VIN_A));

        // Not the value, and not the salt either.
        expect(stored).not.toContain((12_000n).toString(16));
        expect(stored).not.toBe(hex(SALT_1));
        expect(stored).toHaveLength(64);
    });

    it('refuses a second initialisation, which would silently reset history', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_000n, SALT_1);

        expect(() => sim.initialiseOdometer(VIN_A, 5n, SALT_2))
            .toThrow(rejects('odometer already initialised'));
    });

    it('gives two vehicles on the SAME reading different commitments', () => {
        // If salting were broken, an observer could group vehicles by mileage.
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_000n, SALT_1);
        const l = sim.initialiseOdometer(VIN_B, 12_000n, SALT_2);

        expect(hex(l.odometerCommitment.lookup(VIN_A)))
            .not.toBe(hex(l.odometerCommitment.lookup(VIN_B)));
    });
});

// -------------------------------------------------------------------- reading

describe('recordReading', () => {
    beforeEach(() => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_000n, SALT_1);
    });

    it('rejects a reading for a vehicle that has no passport', () => {
        expect(() => sim.recordReading(VIN_B, 20_000n, SALT_2))
            .toThrow(rejects('unknown passport'));
    });

    it('rejects a reading before the odometer is initialised', () => {
        sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);

        expect(() => sim.recordReading(VIN_B, 20_000n, SALT_2))
            .toThrow(rejects('odometer not initialised'));
    });

    it('accepts a higher reading and replaces the commitment', () => {
        const before = hex(sim.ledger.odometerCommitment.lookup(VIN_A));
        const l = sim.recordReading(VIN_A, 18_430n, SALT_2);

        expect(hex(l.odometerCommitment.lookup(VIN_A))).not.toBe(before);
        expect(l.readingCount).toBe(2n);
    });

    it('accepts an unchanged reading — a vehicle can sit still', () => {
        const l = sim.recordReading(VIN_A, 12_000n, SALT_2);

        expect(l.readingCount).toBe(2n);
    });

    it('accumulates readings across a service history', () => {
        sim.recordReading(VIN_A, 18_430n, SALT_2);
        const l = sim.recordReading(VIN_A, 31_780n, SALT_3);

        expect(l.readingCount).toBe(3n);
    });

    // ---- the rollback claim ----

    it('REJECTS a lowered reading — the anti-rollback property', () => {
        expect(() => sim.recordReading(VIN_A, 9_000n, SALT_2))
            .toThrow(rejects('odometer reading decreased'));
    });

    it('rejects a rollback by one kilometre, not just an obvious one', () => {
        expect(() => sim.recordReading(VIN_A, 11_999n, SALT_2))
            .toThrow(rejects('odometer reading decreased'));
    });

    it('leaves the ledger untouched when a rollback is rejected', () => {
        const before = hex(sim.ledger.odometerCommitment.lookup(VIN_A));
        try { sim.recordReading(VIN_A, 9_000n, SALT_2); } catch { /* expected */ }
        const after = sim.ledger;

        expect(hex(after.odometerCommitment.lookup(VIN_A))).toBe(before);
        expect(after.readingCount).toBe(1n);
    });

    it('still rejects a rollback after a legitimate history has built up', () => {
        sim.recordReading(VIN_A, 18_430n, SALT_2);
        sim.recordReading(VIN_A, 31_780n, SALT_3);

        expect(() => sim.recordReading(VIN_A, 20_000n, bytes32(0xd4)))
            .toThrow(rejects('odometer reading decreased'));
    });

    // ---- knowledge of the previous value ----

    it('rejects a caller who does not know the previous READING', () => {
        // Right salt, invented reading: the commitment will not reproduce.
        expect(() => sim.recordReading(VIN_A, 25_000n, SALT_2, { reading: 11_000n, salt: SALT_1 }))
            .toThrow(rejects('previous reading does not open the stored commitment'));
    });

    it('rejects a caller who does not know the previous SALT', () => {
        expect(() => sim.recordReading(VIN_A, 25_000n, SALT_2, { reading: 12_000n, salt: WRONG_SALT }))
            .toThrow(rejects('previous reading does not open the stored commitment'));
    });

    it('rejects a rollback dressed up with a matching false opening', () => {
        // Someone who wants 9 000 accepted must first convince the circuit that
        // the stored commitment opens to something no greater than 9 000. It
        // does not, so this fails on the opening rather than on monotonicity —
        // there is no order of operations that gets a rollback through.
        expect(() => sim.recordReading(VIN_A, 9_000n, SALT_2, { reading: 8_000n, salt: SALT_1 }))
            .toThrow(rejects('previous reading does not open the stored commitment'));
    });

    it('keeps two vehicles isolated from each other', () => {
        sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);
        sim.initialiseOdometer(VIN_B, 90_000n, SALT_2);
        const beforeB = hex(sim.ledger.odometerCommitment.lookup(VIN_B));

        sim.recordReading(VIN_A, 18_430n, SALT_3);

        expect(hex(sim.ledger.odometerCommitment.lookup(VIN_B))).toBe(beforeB);
    });
});

// ---------------------------------------------------------------- disclosure

describe('proveOdometerBelow', () => {
    beforeEach(() => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 120_000n, SALT_1);
    });

    it('rejects a proof about a vehicle with no odometer', () => {
        sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);

        expect(() => sim.proveOdometerBelow(VIN_B, 150_000n))
            .toThrow(rejects('odometer not initialised'));
    });

    it('proves a reading is under the bound', () => {
        expect(() => sim.proveOdometerBelow(VIN_A, 150_000n)).not.toThrow();
    });

    it('accepts a reading exactly on the bound', () => {
        expect(() => sim.proveOdometerBelow(VIN_A, 120_000n)).not.toThrow();
    });

    it('REJECTS a bound the reading exceeds', () => {
        expect(() => sim.proveOdometerBelow(VIN_A, 100_000n))
            .toThrow(rejects('odometer above the claimed bound'));
    });

    it('rejects a bound the reading exceeds by one kilometre', () => {
        expect(() => sim.proveOdometerBelow(VIN_A, 119_999n))
            .toThrow(rejects('odometer above the claimed bound'));
    });

    it('cannot be satisfied by claiming a lower reading', () => {
        // The obvious attack on a threshold proof: assert a flattering value.
        // It has to open the anchored commitment, and it does not.
        expect(() => sim.proveOdometerBelow(VIN_A, 100_000n, { reading: 50_000n, salt: SALT_1 }))
            .toThrow(rejects('reading does not open the stored commitment'));
    });

    it('cannot be satisfied with the right reading and the wrong salt', () => {
        expect(() => sim.proveOdometerBelow(VIN_A, 150_000n, { reading: 120_000n, salt: WRONG_SALT }))
            .toThrow(rejects('reading does not open the stored commitment'));
    });

    it('changes nothing — a query is not an update', () => {
        const before = hex(sim.ledger.odometerCommitment.lookup(VIN_A));
        sim.proveOdometerBelow(VIN_A, 150_000n);
        const after = sim.ledger;

        expect(hex(after.odometerCommitment.lookup(VIN_A))).toBe(before);
        expect(after.readingCount).toBe(1n);
    });

    it('tracks the current reading, not the first one', () => {
        sim.recordReading(VIN_A, 200_000n, SALT_2);

        expect(() => sim.proveOdometerBelow(VIN_A, 150_000n))
            .toThrow(rejects('odometer above the claimed bound'));
        expect(() => sim.proveOdometerBelow(VIN_A, 250_000n)).not.toThrow();
    });
});

// ------------------------------------------------------ the disclosure claim

describe('what the public ledger never learns', () => {
    // The claim ShieldVIN makes to a regulator is that the odometer is
    // attributable without being published. That is one property, and it is
    // worth testing directly rather than inferring it from the API shape.

    const READINGS = [12_345n, 18_430n, 99_999n, 250_000n];

    /** How a leaked Uint<64> would plausibly appear as bytes: padded to 8 or 32. */
    const encodings = (value) => [8, 32].map((width) => {
        const out = new Uint8Array(width);
        let v = value;
        for (let i = width - 1; i >= 0 && v > 0n; i--) {
            out[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        return hex(out);
    });

    it('never writes a reading to the ledger, at any point in a history', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, READINGS[0], SALT_1);

        const salts = [SALT_2, SALT_3, bytes32(0xd4)];
        for (const [i, reading] of READINGS.slice(1).entries()) {
            sim.recordReading(VIN_A, reading, salts[i]);
        }
        sim.proveOdometerBelow(VIN_A, 300_000n);

        const { words, blobs } = sim.ledgerValues();
        for (const reading of READINGS) {
            expect(words).not.toContain(reading);
            for (const encoded of encodings(reading)) {
                expect(blobs).not.toContain(encoded);
            }
        }
    });

    it('never writes a salt to the ledger', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_345n, SALT_1);
        sim.recordReading(VIN_A, 18_430n, SALT_2);

        const { blobs } = sim.ledgerValues();
        expect(blobs).not.toContain(hex(SALT_1));
        expect(blobs).not.toContain(hex(SALT_2));
    });

    it('the collector would actually catch a leak', () => {
        // A privacy test that can only ever pass is not a test. This pins the
        // collector itself: a value that IS on the ledger has to be found by
        // the same search the assertions above rely on.
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_345n, SALT_1);

        const { words, blobs } = sim.ledgerValues();
        expect(blobs).toContain(hex(ROOT));         // public by design
        expect(blobs).toContain(hex(REGISTRAR));    // public by design
        expect(words).toContain(1n);                // the reading counter
    });

    it('publishes exactly what a verifier needs and nothing else', () => {
        // The VIN hash, the content root and the registrar ARE public by
        // design: a verifier has to be able to find the passport and see who
        // vouched for it. This test pins that intent, so widening the public
        // surface later has to be a deliberate edit to a named expectation.
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 12_345n, SALT_1);
        const l = sim.ledger;

        expect(hex(l.passports.lookup(VIN_A))).toBe(hex(ROOT));
        expect(hex(l.registrar.lookup(VIN_A))).toBe(hex(REGISTRAR));
        expect(l.readingCount).toBe(1n);
        expect(hex(l.odometerCommitment.lookup(VIN_A))).toHaveLength(64);
    });

    it('leaks nothing through the reading counter beyond how many there were', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseOdometer(VIN_A, 1n, SALT_1);
        const low = sim.ledger.readingCount;

        const other = new PassportSimulator();
        other.registerPassport(VIN_A, ROOT, REGISTRAR);
        other.initialiseOdometer(VIN_A, 999_999n, SALT_1);

        // Two wildly different vehicles, indistinguishable by the counter.
        expect(other.ledger.readingCount).toBe(low);
    });
});
