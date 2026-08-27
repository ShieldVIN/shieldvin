/**
 * Contract tests for `vinpassport`.
 *
 * These run the COMPILED circuits against a local ledger, so an assertion that
 * fires here is the same assertion that would reject the transaction on chain.
 *
 * The suite is organised around one question per circuit, then the three that
 * actually matter for a vehicle passport:
 *
 *   MONOTONICITY  can a holder move a field the way it must never move?
 *   KNOWLEDGE     can someone write a field without knowing its current value?
 *   DISCLOSURE    does any field value ever reach the public ledger?
 *
 * Values are scaled x1000, matching `VALUE_SCALE` in `@odatano/dpp-sdk`, so a
 * a value of 96.4% is 96_400 here exactly as it would be in the field panel.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PassportSimulator, Rule, bytes32, hex, fieldKey } from './passport-simulator.mjs';

const VIN_A = bytes32(0x11);
const VIN_B = bytes32(0x22);
const ROOT = bytes32(0xaa);
const ROOT_B = bytes32(0xbb);
const REGISTRAR = bytes32(0x77);

// Real field labels — blake2b-256 of the field name, as the SDK derives them.
const ODO = fieldKey('odometerKm');
const ACCIDENTS = fieldKey('accidentCount');
const OWNERS = fieldKey('ownerCount');
const WRITE_OFF = fieldKey('writeOffCategory');
// Every field the panel uses today only rises. This one stands in for a field
// that may only fall — see FIELDS in the simulator for why the contract keeps
// that direction available.
const DECLINING = fieldKey('reservedNumeric0');

const S1 = bytes32(0xd1);
const S2 = bytes32(0xd2);
const S3 = bytes32(0xd3);
const WRONG_SALT = bytes32(0xee);

const PCT = (n) => BigInt(Math.round(n * 1000));

/** A Compact `assert` failure, as the runtime surfaces it. */
const rejects = (message) => new RegExp(`failed assert: ${message}`);

let sim;
beforeEach(() => {
    sim = new PassportSimulator();
});

/** A registered vehicle with the five fields this suite exercises. */
function registered(vin = VIN_A, root = ROOT) {
    sim.registerPassport(vin, root, REGISTRAR);
    sim.initialiseField(vin, ODO, Rule.neverFalls, 12n, S1);
    sim.initialiseField(vin, ACCIDENTS, Rule.neverFalls, 0n, S1);
    sim.initialiseField(vin, OWNERS, Rule.neverFalls, 1n, S1);
    sim.initialiseField(vin, WRITE_OFF, Rule.neverFalls, 0n, S1);
    sim.initialiseField(vin, DECLINING, Rule.neverRises, PCT(100), S1);
}

// ---------------------------------------------------------------- registration

describe('registerPassport', () => {
    it('anchors the content root and the registrar against the VIN hash', () => {
        const l = sim.registerPassport(VIN_A, ROOT, REGISTRAR);

        expect(hex(l.passports.lookup(VIN_A))).toBe(hex(ROOT));
        expect(hex(l.registrar.lookup(VIN_A))).toBe(hex(REGISTRAR));
    });

    it('creates no fields — registration and history are separate acts', () => {
        const l = sim.registerPassport(VIN_A, ROOT, REGISTRAR);

        expect(l.fieldCommitment.isEmpty()).toBe(true);
        expect(l.updateCount).toBe(0n);
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
});

// ------------------------------------------------------------------- creation

describe('initialiseField', () => {
    it('will not create a field on a vehicle that has no passport', () => {
        expect(() => sim.initialiseField(VIN_A, ODO, Rule.neverFalls, 12n, S1))
            .toThrow(rejects('unknown passport'));
    });

    it('stores a commitment and counts the update', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        const l = sim.initialiseField(VIN_A, ODO, Rule.neverFalls, 12_000n, S1);

        expect(l.fieldCommitment.size()).toBe(1n);
        expect(l.updateCount).toBe(1n);
    });

    it('stores a commitment, not the value and not the salt', () => {
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.initialiseField(VIN_A, ODO, Rule.neverFalls, 12_000n, S1);

        const { words, blobs } = sim.ledgerValues();
        expect(words).not.toContain(12_000n);
        expect(blobs).not.toContain(hex(S1));
    });

    it('records the rule each field was created under', () => {
        registered();
        const l = sim.ledger;
        const rules = [...l.fieldRule].map(([, rule]) => rule);

        expect(rules.filter((r) => r === Rule.neverFalls)).toHaveLength(4);
        expect(rules.filter((r) => r === Rule.neverRises)).toHaveLength(1);
    });

    it('refuses a second creation, which would silently reset history', () => {
        registered();

        expect(() => sim.initialiseField(VIN_A, ODO, Rule.neverFalls, 5n, S2))
            .toThrow(rejects('field already initialised'));
    });

    it('REFUSES to recreate a field under a friendlier rule', () => {
        // The attack this blocks: create a field under one rule, then recreate
        // it under the friendlier one so the value can move the forbidden way.
        registered();

        expect(() => sim.initialiseField(VIN_A, DECLINING, Rule.neverFalls, PCT(100), S2))
            .toThrow(rejects('field already initialised'));
        expect(sim.ledger.fieldRule.lookup([...sim.ledger.fieldRule].find(
            ([, r]) => r === Rule.neverRises
        )[0])).toBe(Rule.neverRises);
    });

    it('gives two vehicles holding the SAME value different commitments', () => {
        // If salting were broken, an observer could group vehicles by mileage.
        sim.registerPassport(VIN_A, ROOT, REGISTRAR);
        sim.registerPassport(VIN_B, ROOT_B, REGISTRAR);
        sim.initialiseField(VIN_A, ODO, Rule.neverFalls, 12_000n, S1);
        sim.initialiseField(VIN_B, ODO, Rule.neverFalls, 12_000n, S2);

        const commitments = [...sim.ledger.fieldCommitment].map(([, c]) => hex(c));
        expect(new Set(commitments).size).toBe(2);
    });

    it('gives two fields of one vehicle holding the same value different slots', () => {
        registered();
        // accidentCount, writeOffCategory and ownerCount were seeded 0, 0, 1.
        expect(sim.ledger.fieldCommitment.size()).toBe(5n);
    });
});

// ------------------------------------------------------ fields that never fall

describe('recordField — a field that may never fall', () => {
    beforeEach(() => { registered(); });

    it('rejects a write to a vehicle that has no passport', () => {
        expect(() => sim.recordField(VIN_B, ODO, 20_000n, S2))
            .toThrow(rejects('unknown passport'));
    });

    it('rejects a write to a field that was never created', () => {
        expect(() => sim.recordField(VIN_A, fieldKey('serviceCount'), 1n, S2))
            .toThrow(rejects('field not initialised'));
    });

    it('accepts a higher odometer and replaces the commitment', () => {
        const before = [...sim.ledger.fieldCommitment].map(([, c]) => hex(c));
        const l = sim.recordField(VIN_A, ODO, 18_430n, S2);
        const after = [...l.fieldCommitment].map(([, c]) => hex(c));

        expect(after).not.toEqual(before);
        expect(l.updateCount).toBe(6n);
    });

    it('accepts an unchanged odometer — a vehicle can sit still', () => {
        expect(() => sim.recordField(VIN_A, ODO, 12n, S2)).not.toThrow();
    });

    it('REJECTS a lowered odometer — the anti-rollback property', () => {
        sim.recordField(VIN_A, ODO, 18_430n, S2);

        expect(() => sim.recordField(VIN_A, ODO, 9_000n, S3))
            .toThrow(rejects('value decreased'));
    });

    it('rejects a rollback by one kilometre, not just an obvious one', () => {
        sim.recordField(VIN_A, ODO, 18_430n, S2);

        expect(() => sim.recordField(VIN_A, ODO, 18_429n, S3))
            .toThrow(rejects('value decreased'));
    });

    it('REJECTS erasing an accident', () => {
        sim.recordField(VIN_A, ACCIDENTS, 1n, S2);

        expect(() => sim.recordField(VIN_A, ACCIDENTS, 0n, S3))
            .toThrow(rejects('value decreased'));
    });

    it('REJECTS clearing a write-off — the title-washing move', () => {
        sim.recordField(VIN_A, WRITE_OFF, 2n, S2);   // category S, structural

        expect(() => sim.recordField(VIN_A, WRITE_OFF, 0n, S3))
            .toThrow(rejects('value decreased'));
    });

    it('REJECTS reducing the keeper count', () => {
        sim.recordField(VIN_A, OWNERS, 3n, S2);

        expect(() => sim.recordField(VIN_A, OWNERS, 1n, S3))
            .toThrow(rejects('value decreased'));
    });

    it('leaves the ledger untouched when a write is rejected', () => {
        const before = [...sim.ledger.fieldCommitment].map(([k, c]) => hex(k) + hex(c));
        try { sim.recordField(VIN_A, ODO, 5n, S2); } catch { /* expected */ }
        const after = sim.ledger;

        expect([...after.fieldCommitment].map(([k, c]) => hex(k) + hex(c))).toEqual(before);
        expect(after.updateCount).toBe(5n);
    });
});

// ------------------------------------------------------ fields that never rise

describe('recordField — a field that may never rise', () => {
    beforeEach(() => { registered(); });

    it('accepts degradation', () => {
        const l = sim.recordField(VIN_A, DECLINING, PCT(96.4), S2);

        expect(l.updateCount).toBe(6n);
    });

    it('accepts an unchanged reading', () => {
        expect(() => sim.recordField(VIN_A, DECLINING, PCT(100), S2)).not.toThrow();
    });

    it('REJECTS a value that climbed back up', () => {
        // The mirror of the rollback case. A field created under neverRises has
        // declared that it only ever falls, and the circuit holds it to that
        // for the life of the passport.
        sim.recordField(VIN_A, DECLINING, PCT(96.4), S2);

        expect(() => sim.recordField(VIN_A, DECLINING, PCT(99), S3))
            .toThrow(rejects('value increased'));
    });

    it('rejects an increase of a tenth of a percent', () => {
        sim.recordField(VIN_A, DECLINING, PCT(96.4), S2);

        expect(() => sim.recordField(VIN_A, DECLINING, PCT(96.5), S3))
            .toThrow(rejects('value increased'));
    });

    it('accepts a long declining history', () => {
        sim.recordField(VIN_A, DECLINING, PCT(96.4), S2);
        sim.recordField(VIN_A, DECLINING, PCT(94.1), S3);
        const l = sim.recordField(VIN_A, DECLINING, PCT(91.8), bytes32(0xd4));

        expect(l.updateCount).toBe(8n);
    });

    it('applies the opposite rule to another field on the SAME vehicle', () => {
        // The point of storing the rule per field: one vehicle, two directions,
        // and neither field can borrow the other's rule.
        expect(() => sim.recordField(VIN_A, ODO, 5n, S2))
            .toThrow(rejects('value decreased'));
        expect(() => {
            sim.recordField(VIN_A, DECLINING, PCT(96), S2);
            sim.recordField(VIN_A, DECLINING, PCT(97), S3);
        }).toThrow(rejects('value increased'));
    });
});

// ------------------------------------------------------------- knowing the value

describe('recordField — proving you know the current value', () => {
    beforeEach(() => { registered(); });

    it('rejects a caller who does not know the current VALUE', () => {
        expect(() => sim.recordField(VIN_A, ODO, 25_000n, S2, { value: 11n, salt: S1 }))
            .toThrow(rejects('previous value does not open the stored commitment'));
    });

    it('rejects a caller who does not know the current SALT', () => {
        expect(() => sim.recordField(VIN_A, ODO, 25_000n, S2, { value: 12n, salt: WRONG_SALT }))
            .toThrow(rejects('previous value does not open the stored commitment'));
    });

    it('rejects a rollback dressed up with a matching false opening', () => {
        // To get 5 accepted, a seller must first convince the circuit that the
        // stored commitment opens to something no greater than 5. It does not,
        // so this fails on the opening rather than on monotonicity — there is
        // no order of operations that gets a rollback through.
        expect(() => sim.recordField(VIN_A, ODO, 5n, S2, { value: 4n, salt: S1 }))
            .toThrow(rejects('previous value does not open the stored commitment'));
    });

    it('rejects opening one field with another field\'s value', () => {
        // odometer is 12, accidents is 0 — both on the same vehicle, both under
        // the same salt. The slots must still be independent.
        expect(() => sim.recordField(VIN_A, ACCIDENTS, 1n, S2, { value: 12n, salt: S1 }))
            .toThrow(rejects('previous value does not open the stored commitment'));
    });

    it('keeps two vehicles isolated', () => {
        registered(VIN_B, ROOT_B);
        const beforeB = [...sim.ledger.fieldCommitment].length;

        sim.recordField(VIN_A, ODO, 18_430n, S2);

        expect([...sim.ledger.fieldCommitment].length).toBe(beforeB);
    });
});

// ------------------------------------------------------------------- thresholds

describe('proveFieldAtMost', () => {
    beforeEach(() => {
        registered();
        sim.recordField(VIN_A, ODO, 120_000n, S2);
    });

    it('rejects a proof about a field that does not exist', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, fieldKey('co2FootprintKgCO2e'), 1n))
            .toThrow(rejects('field not initialised'));
    });

    it('proves the odometer is under a bound', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 150_000n)).not.toThrow();
    });

    it('accepts a value exactly on the bound', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 120_000n)).not.toThrow();
    });

    it('REJECTS a bound the value exceeds', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 100_000n))
            .toThrow(rejects('value above the claimed bound'));
    });

    it('rejects a bound the value exceeds by one', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 119_999n))
            .toThrow(rejects('value above the claimed bound'));
    });

    it('proves "never had a reported accident" as a bound of zero', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ACCIDENTS, 0n)).not.toThrow();
    });

    it('fails that claim once an accident is on record', () => {
        sim.recordField(VIN_A, ACCIDENTS, 1n, S3);

        expect(() => sim.proveFieldAtMost(VIN_A, ACCIDENTS, 0n))
            .toThrow(rejects('value above the claimed bound'));
    });

    it('proves "never written off" as a bound of zero', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n)).not.toThrow();
    });

    it('cannot be satisfied by claiming a flattering value', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 100_000n, { value: 50_000n, salt: S2 }))
            .toThrow(rejects('value does not open the stored commitment'));
    });

    it('changes nothing — a query is not an update', () => {
        const before = sim.ledger.updateCount;
        sim.proveFieldAtMost(VIN_A, ODO, 150_000n);

        expect(sim.ledger.updateCount).toBe(before);
    });

    it('tracks the current value, not the first one', () => {
        expect(() => sim.proveFieldAtMost(VIN_A, ODO, 100n))
            .toThrow(rejects('value above the claimed bound'));
    });
});

describe('proveFieldAtLeast', () => {
    beforeEach(() => {
        registered();
        sim.recordField(VIN_A, DECLINING, PCT(96.4), S2);
    });

    it('proves a value is above a floor', () => {
        expect(() => sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90))).not.toThrow();
    });

    it('accepts a value exactly on the floor', () => {
        expect(() => sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(96.4))).not.toThrow();
    });

    it('REJECTS a floor the value falls short of', () => {
        expect(() => sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(98)))
            .toThrow(rejects('value below the claimed bound'));
    });

    it('fails the claim once the value has fallen past it', () => {
        sim.recordField(VIN_A, DECLINING, PCT(88), S3);

        expect(() => sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90)))
            .toThrow(rejects('value below the claimed bound'));
    });

    it('cannot be satisfied with the right value and the wrong salt', () => {
        expect(() => sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90), { value: PCT(96.4), salt: WRONG_SALT }))
            .toThrow(rejects('value does not open the stored commitment'));
    });

    it('changes nothing', () => {
        const before = sim.ledger.updateCount;
        sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90));

        expect(sim.ledger.updateCount).toBe(before);
    });
});

// ------------------------------------------------------ the disclosure claim

describe('claims — what a verifier can read afterwards', () => {
    // A proof circuit that only asserted would leave nothing behind: the
    // transaction's success IS the proof, but nothing would index it by
    // vehicle, so a scan-to-verdict page would have no state to read.

    /** The single claim on the ledger, when exactly one is expected. */
    const onlyClaim = () => {
        const l = sim.ledger;
        expect(l.claims.size()).toBe(1n);
        for (const [, claim] of l.claims) { return claim; }
        throw new Error('unreachable: size() said 1');
    };

    it('records a claim when the proof succeeds', () => {
        registered();
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);

        const claim = onlyClaim();
        expect(hex(claim.vinHash)).toBe(hex(VIN_A));
        expect(hex(claim.fieldKey)).toBe(hex(WRITE_OFF));
        expect(claim.bound).toBe(0n);
        expect(claim.atMost).toBe(true);
    });

    it('records nothing when the proof fails', () => {
        // The transaction aborts, so the ledger write never happens. A claims
        // ledger that could be written by a failed proof would be worse than
        // no claims ledger at all.
        registered();
        sim.recordField(VIN_A, ACCIDENTS, 2n, S2);

        expect(() => sim.proveFieldAtMost(VIN_A, ACCIDENTS, 0n))
            .toThrow(rejects('value above the claimed bound'));
        expect(sim.ledger.claims.size()).toBe(0n);
    });

    it('binds the claim to the value it was proven against', () => {
        // The commitment in the claim is the version of the field the proof
        // opened. A verifier compares it against the CURRENT commitment for
        // the same slot; equal means live, different means superseded.
        registered();
        sim.proveFieldAtMost(VIN_A, ODO, 300_000n);

        const claim = onlyClaim();
        const l = sim.ledger;
        expect(hex(l.fieldCommitment.lookup(claim.slot))).toBe(hex(claim.commitment));
    });

    it('a later reading leaves the old claim standing but no longer current', () => {
        // This is the property that stops a claim quietly becoming a lie. The
        // odometer passes 300 000; the old "at most 300 000" is still on the
        // ledger, but it no longer describes the current value, and a verifier
        // can see that without being told.
        registered();
        sim.proveFieldAtMost(VIN_A, ODO, 300_000n);
        const claim = onlyClaim();

        sim.recordField(VIN_A, ODO, 310_000n, S2);

        const l = sim.ledger;
        expect(l.claims.size()).toBe(1n);                      // still there
        expect(hex(l.fieldCommitment.lookup(claim.slot)))
            .not.toBe(hex(claim.commitment));                  // no longer current
    });

    it('re-proving the same claim about the same value is idempotent', () => {
        registered();
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);

        expect(sim.ledger.claims.size()).toBe(1n);
    });

    it('separates a ceiling from a floor at the same bound', () => {
        // "at most 0" and "at least 0" are different claims about the same
        // field. Domain separation in the claim key is what keeps them apart;
        // without it one would silently overwrite the other.
        registered();
        sim.proveFieldAtMost(VIN_A, ACCIDENTS, 0n);
        sim.proveFieldAtLeast(VIN_A, ACCIDENTS, 0n);

        const l = sim.ledger;
        expect(l.claims.size()).toBe(2n);
        const directions = [];
        for (const [, c] of l.claims) { directions.push(c.atMost); }
        expect(directions.sort()).toEqual([false, true]);
    });

    it('separates two bounds on the same field', () => {
        registered();
        sim.proveFieldAtMost(VIN_A, ODO, 300_000n);
        sim.proveFieldAtMost(VIN_A, ODO, 400_000n);

        expect(sim.ledger.claims.size()).toBe(2n);
    });

    it('separates the same claim about two different vehicles', () => {
        registered(VIN_A, ROOT);
        registered(VIN_B, ROOT_B);
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);
        sim.proveFieldAtMost(VIN_B, WRITE_OFF, 0n);

        const l = sim.ledger;
        expect(l.claims.size()).toBe(2n);
        const vins = [];
        for (const [, c] of l.claims) { vins.push(hex(c.vinHash)); }
        expect(vins.sort()).toEqual([hex(VIN_A), hex(VIN_B)].sort());
    });

    it('records a floor claim from proveFieldAtLeast', () => {
        registered();
        sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90));

        const claim = onlyClaim();
        expect(hex(claim.fieldKey)).toBe(hex(DECLINING));
        expect(claim.bound).toBe(PCT(90));
        expect(claim.atMost).toBe(false);
    });

    it('carries everything a verifier needs without computing a hash', () => {
        // The scan page is plain JS with no build step, so it cannot run
        // persistentHash to derive a key. Every field it needs to render a
        // verdict has to be readable straight off the claim. See D19.
        registered();
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);

        const claim = onlyClaim();
        for (const part of ['slot', 'vinHash', 'fieldKey', 'commitment']) {
            expect(claim[part]).toBeInstanceOf(Uint8Array);
            expect(claim[part]).toHaveLength(32);
        }
        expect(typeof claim.bound).toBe('bigint');
        expect(typeof claim.atMost).toBe('boolean');
    });
});

describe('what the public ledger never learns', () => {
    // The claim VINPassport makes to a regulator is that a vehicle's history is
    // attributable without being published. That is one property, and it is
    // worth testing directly rather than inferring it from the API shape.

    const HISTORY = [12n, 18_430n, 99_999n, 250_000n];

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

    it('never writes a field value to the ledger, at any point in a history', () => {
        registered();
        const salts = [S2, S3, bytes32(0xd4)];
        for (const [i, value] of HISTORY.slice(1).entries()) {
            sim.recordField(VIN_A, ODO, value, salts[i]);
        }
        sim.recordField(VIN_A, DECLINING, PCT(96.4), bytes32(0xd5));
        sim.proveFieldAtMost(VIN_A, ODO, 300_000n);
        sim.proveFieldAtLeast(VIN_A, DECLINING, PCT(90));

        const { words, blobs } = sim.ledgerValues();
        for (const value of [...HISTORY, PCT(96.4), PCT(100)]) {
            expect(words).not.toContain(value);
            for (const encoded of encodings(value)) {
                expect(blobs).not.toContain(encoded);
            }
        }
    });

    it('never writes a salt to the ledger', () => {
        registered();
        sim.recordField(VIN_A, ODO, 18_430n, S2);

        const { blobs } = sim.ledgerValues();
        for (const salt of [S1, S2]) {
            expect(blobs).not.toContain(hex(salt));
        }
    });

    it('does not reveal WHICH field a slot holds, until a claim names it', () => {
        // The slot key is a domain-separated hash of the VIN and the field
        // label. An observer who does not already know both cannot tell the
        // odometer's slot from the write-off category's.
        registered();
        const { blobs } = sim.ledgerValues();

        for (const label of [ODO, ACCIDENTS, OWNERS, WRITE_OFF, DECLINING]) {
            expect(blobs).not.toContain(hex(label));
        }
    });

    it('a proven claim publishes which field it is about, by design', () => {
        // This is a DISCLOSURE, and it is deliberate: a verdict a verifier
        // cannot read is not a verdict. Proving "never written off" has to say
        // that it is the write-off category being claimed about.
        //
        // What it does NOT publish is the value. That distinction is the whole
        // design, so it is pinned here rather than left to the prose.
        registered();
        sim.proveFieldAtMost(VIN_A, WRITE_OFF, 0n);

        const { words, blobs } = sim.ledgerValues();
        expect(blobs).toContain(hex(WRITE_OFF));   // the field, deliberately
        expect(blobs).toContain(hex(VIN_A));       // already public via passports

        // The other fields stay unnamed: only what was claimed about surfaces.
        for (const label of [ODO, ACCIDENTS, OWNERS, DECLINING]) {
            expect(blobs).not.toContain(hex(label));
        }
        // 0 is both the bound and the value here, so it cannot be used to
        // separate them. A field whose value differs from its bound can.
        sim.proveFieldAtMost(VIN_A, ODO, 300_000n);
        const after = sim.ledgerValues();
        expect(after.words).toContain(300_000n);   // the bound is public
        expect(after.words).not.toContain(12n);    // the reading is not
    });

    it('the collector would actually catch a leak', () => {
        // A privacy test that can only ever pass is not a test. This pins the
        // collector itself: values that ARE on the ledger must be found by the
        // same search the assertions above rely on.
        registered();

        const { words, blobs } = sim.ledgerValues();
        expect(blobs).toContain(hex(ROOT));       // public by design
        expect(blobs).toContain(hex(REGISTRAR));  // public by design
        expect(words).toContain(5n);              // the update counter
    });

    it('publishes exactly what a verifier needs and nothing else', () => {
        registered();
        const l = sim.ledger;

        expect(hex(l.passports.lookup(VIN_A))).toBe(hex(ROOT));
        expect(hex(l.registrar.lookup(VIN_A))).toBe(hex(REGISTRAR));
        expect(l.fieldCommitment.size()).toBe(5n);
        expect(l.updateCount).toBe(5n);
        for (const [, commitment] of l.fieldCommitment) {
            expect(hex(commitment)).toHaveLength(64);
        }
    });

    it('leaks nothing through the counter beyond how many updates there were', () => {
        registered();
        const mine = sim.ledger.updateCount;

        const other = new PassportSimulator();
        other.registerPassport(VIN_A, ROOT, REGISTRAR);
        other.initialiseField(VIN_A, ODO, Rule.neverFalls, 999_999n, S1);
        other.initialiseField(VIN_A, ACCIDENTS, Rule.neverFalls, 7n, S1);
        other.initialiseField(VIN_A, OWNERS, Rule.neverFalls, 9n, S1);
        other.initialiseField(VIN_A, WRITE_OFF, Rule.neverFalls, 2n, S1);
        other.initialiseField(VIN_A, DECLINING, Rule.neverRises, PCT(41), S1);

        // A pristine one-owner car and a written-off wreck, indistinguishable.
        expect(other.ledger.updateCount).toBe(mine);
    });
});
