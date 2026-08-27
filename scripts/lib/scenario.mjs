/**
 * Shared scenario machinery for everything that builds ledger state off-chain:
 * the demo export and the intake runner. One module so the two cannot drift —
 * a vehicle added through the console is built by exactly the code that built
 * the demo vehicles.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { PassportSimulator, Rule, fieldKey, bytes32, hex } from '../../test/passport-simulator.mjs';

export { PassportSimulator, Rule, fieldKey, bytes32, hex };

// ---------------------------------------------------------------- vocabulary

/** The panel fields the surfaces know how to render. */
export const FIELDS = {
    odometerKm:       { label: 'Mileage',            kind: 'km',       rule: Rule.neverFalls },
    accidentCount:    { label: 'Reported accidents', kind: 'count',    rule: Rule.neverFalls },
    ownerCount:       { label: 'Keepers',            kind: 'count',    rule: Rule.neverFalls },
    writeOffCategory: { label: 'Write-off category', kind: 'category', rule: Rule.neverFalls },
    serviceCount:     { label: 'Services recorded',  kind: 'count',    rule: Rule.neverFalls }
};

export const K = Object.fromEntries(Object.keys(FIELDS).map((n) => [n, fieldKey(n)]));

/** A vehicle is addressed by the hash of its VIN, never the VIN itself. */
export const vinHash = (vin) => fieldKey(vin);

/**
 * The content root for a registration.
 *
 * Interim canonicalisation: blake2b of the sorted-key JSON of the initial
 * fields. When anchoring is wired through @odatano/dpp-sdk, this becomes the
 * 32-slot panel tree root — the registration call does not change shape,
 * which is why the placeholder is acceptable for now.
 */
export const contentRoot = (vin, fields) => {
    const canonical = JSON.stringify(
        { vin, fields: Object.fromEntries(Object.entries(fields).sort()) }
    );
    return fieldKey(`shieldvin:root:v0:${canonical}`);
};

export const registrarId = (name) => fieldKey(`shieldvin:registrar:${name}`);

// ---------------------------------------------------------------- salts

/** Deterministic salt stream so a scenario is reproducible run to run. */
export const saltStream = () => {
    let n = 0;
    return () => bytes32(++n % 251 || 1);
};

// ---------------------------------------------------------------- intake

/**
 * Apply one intake — a vehicle's registration, history and requested claims —
 * to a simulator, through the real compiled circuits.
 *
 * Refusals are results, not crashes: an update that breaks a field's rule or
 * a claim the state cannot support is REFUSED IN-CIRCUIT, reported as such,
 * and the run continues. The intake runner's honesty mirrors the chain's — a
 * refused claim writes nothing, so it can never appear proven.
 *
 * Returns { vinHex, applied: [..], refused: [{step, reason}] }.
 */
export function applyIntake(sim, intake, salt) {
    const vin = vinHash(intake.vin);
    const vinHex = hex(vin);
    const applied = [];
    const refused = [];
    const attempt = (step, fn) => {
        try { fn(); applied.push(step); }
        catch (e) {
            refused.push({ step, reason: String(e.message ?? e).replace(/^.*failed assert: /, '') });
        }
    };

    attempt('registerPassport', () =>
        sim.registerPassport(vin, contentRoot(intake.vin, intake.fields), registrarId(intake.registrar)));

    for (const [name, value] of Object.entries(intake.fields)) {
        if (!(name in FIELDS)) { refused.push({ step: `initialiseField ${name}`, reason: 'unknown field' }); continue; }
        attempt(`initialiseField ${name}`, () =>
            sim.initialiseField(vin, K[name], FIELDS[name].rule, BigInt(value), salt()));
    }

    for (const [i, update] of (intake.updates ?? []).entries()) {
        for (const [name, value] of Object.entries(update)) {
            if (!(name in FIELDS)) { refused.push({ step: `update ${i + 1} ${name}`, reason: 'unknown field' }); continue; }
            attempt(`update ${i + 1}: ${name} -> ${value}`, () =>
                sim.recordField(vin, K[name], BigInt(value), salt()));
        }
    }

    const CLAIMS = {
        neverWrittenOff: () => sim.proveFieldAtMost(vin, K.writeOffCategory, 0n),
        noAccidents:     () => sim.proveFieldAtMost(vin, K.accidentCount, 0n),
        oneKeeper:       () => sim.proveFieldAtMost(vin, K.ownerCount, 1n),
        mileageUnder:    () => sim.proveFieldAtMost(vin, K.odometerKm, BigInt(intake.prove.mileageUnder))
    };
    for (const [name, run] of Object.entries(CLAIMS)) {
        const wanted = name === 'mileageUnder' ? intake.prove?.mileageUnder : intake.prove?.[name];
        if (wanted) attempt(`prove ${name}`, run);
    }

    return { vinHex, applied, refused };
}

// ---------------------------------------------------------------- demo pair

/** The two standing demonstration vehicles. Returns their vin hex hashes. */
export function buildDemoVehicles(sim, salt) {
    const a = applyIntake(sim, {
        vin: 'WVWZZZ1JZXW000001',
        registrar: 'demo-authority',
        fields: { odometerKm: 18_430, accidentCount: 0, ownerCount: 1, writeOffCategory: 0, serviceCount: 1 },
        updates: [
            { odometerKm: 44_210, serviceCount: 2 },
            { odometerKm: 61_890, serviceCount: 3 },
            { odometerKm: 83_260, serviceCount: 4 }
        ],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: true, mileageUnder: 150_000 }
    }, salt);

    const b = applyIntake(sim, {
        vin: 'WAUZZZ8V5KA000002',
        registrar: 'demo-authority',
        fields: { odometerKm: 96_500, accidentCount: 2, ownerCount: 3, writeOffCategory: 1 },
        updates: [{ odometerKm: 112_040 }],
        prove: { mileageUnder: 200_000 }
    }, salt);

    return { a, b };
}

// ---------------------------------------------------------------- export

export function exportLedger(sim, sourceNote) {
    const l = sim.ledger;
    const mapToObj = (m, val) => {
        const out = {};
        for (const [k, v] of m) out[hex(k)] = val(v);
        return out;
    };
    const claims = [];
    for (const [key, c] of l.claims) {
        claims.push({
            key: hex(key), slot: hex(c.slot), vinHash: hex(c.vinHash),
            fieldKey: hex(c.fieldKey), commitment: hex(c.commitment),
            bound: c.bound.toString(), atMost: c.atMost
        });
    }
    return {
        source: sourceNote,
        note: 'Real public ledger state. Values and salts never leave the generating process.',
        passports: mapToObj(l.passports, hex),
        registrar: mapToObj(l.registrar, hex),
        fieldCommitment: mapToObj(l.fieldCommitment, hex),
        fieldRule: mapToObj(l.fieldRule, (r) => Number(r)),
        claims,
        updateCount: l.updateCount.toString()
    };
}

export function vocabulary(demoVehicles) {
    return {
        note: 'Public vocabulary: blake2b-256(field name) -> display metadata. See docs/FIELDS.md.',
        fields: Object.fromEntries(
            Object.entries(FIELDS).map(([name, meta]) => [
                hex(K[name]), { name, label: meta.label, kind: meta.kind }
            ])
        ),
        demoVehicles
    };
}
