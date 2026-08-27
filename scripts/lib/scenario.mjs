/**
 * Shared scenario machinery for everything that builds ledger state off-chain:
 * the demo export and the intake runner. One module so the two cannot drift —
 * a vehicle added through the console is built by exactly the code that built
 * the demo vehicles.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { PassportSimulator, Rule, fieldKey, bytes32, hex } from '../../test/passport-simulator.mjs';
import { buildTree, padToWidth } from '@odatano/dpp-sdk/merkle';
import { blake2b } from '@noble/hashes/blake2';

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
 * The full 32-slot panel, exactly as docs/FIELDS.md lays it out. Slots 0-4
 * are the live rule-bearing fields; 5-16 numeric declarations; 22-29 strings;
 * 17-21 and 30-31 reserved. The regulation-facing majority of the passport -
 * vehicle category, fuel type (EV / hybrid / diesel / petrol), emissions
 * class, the battery passport link, the Art 29 recycled-content declarations
 * - lives HERE, anchored under the content root, not in the live fields.
 */
export const PANEL = {
    odometerKm: [0, 'num'], accidentCount: [1, 'num'], ownerCount: [2, 'num'],
    serviceCount: [3, 'num'], writeOffCategory: [4, 'num'],
    firstRegistrationDate: [5, 'num'], lastInspectionDate: [6, 'num'],
    co2FootprintKgCO2e: [7, 'num'], recycledPlasticPct: [8, 'num'],
    recycledPlasticFromELVPct: [9, 'num'], recycledSteelPct: [10, 'num'],
    recycledAluminiumPct: [11, 'num'], criticalRawMaterialPct: [12, 'num'],
    reusabilityPct: [13, 'num'], recyclabilityPct: [14, 'num'],
    recoverabilityPct: [15, 'num'], dismantlingTimeMinutes: [16, 'num'],
    vinHash: [22, 'str'], vehicleCategory: [23, 'str'],
    euTypeApprovalNumber: [24, 'str'], manufacturerBPN: [25, 'str'],
    fuelType: [26, 'str'], batteryChemistry: [27, 'str'],
    emissionsClass: [28, 'str'], batteryPassportId: [29, 'str'],
    passportOrigin: [30, 'str']   // 'new' | 'retrofit' - provisional, see FIELDS.md
};

const VALUE_SCALE = 1000;   // matches @odatano/dpp-sdk VALUE_SCALE
const b2b = (data) => blake2b(data, { dkLen: 32 });
const utf8 = (s) => new TextEncoder().encode(s);
const nodeHash = (l, r) => b2b(Uint8Array.from([...l, ...r]));

/**
 * The content root: the real depth-5 tree over the 32-slot panel, built with
 * @odatano/dpp-sdk's own machinery.
 *
 * Leaf rule (shieldvin:leaf:v0): blake2b( tag || slotSalt || fieldKey ||
 * valueDigest ), where numerics digest their x1000-scaled decimal and strings
 * their exact bytes. EVERY slot is salted, occupied or not, so an observer of
 * two roots cannot tell which slots are filled - absence is as private as
 * presence (FIELDS.md: "absent leaves are still salted and still anchored").
 *
 * DEMO-ONLY SALTS: derived from the VIN so a scenario reproduces exactly.
 * Real operation derives them from a managed contentSaltSeed whose loss makes
 * the root permanently unprovable - BUILD-SCOPE carries that risk by name.
 */
export const contentRoot = (vin, fields, panel = {}) => {
    const values = { ...panel, ...fields, vinHash: hex(vinHash(vin)) };
    const leaves = [];
    for (let slot = 0; slot < 32; slot++) {
        const name = Object.keys(PANEL).find((n) => PANEL[n][0] === slot);
        const slotSalt = b2b(utf8(`shieldvin:leafsalt:v0:${vin}:${slot}`));
        let valueDigest = b2b(utf8(''));                       // absent / reserved
        if (name && values[name] !== undefined && values[name] !== '') {
            const kind = PANEL[name][1];
            valueDigest = kind === 'num'
                ? b2b(utf8(String(BigInt(Math.round(Number(values[name]) * VALUE_SCALE)))))
                : b2b(utf8(String(values[name])));
        }
        leaves.push(b2b(Uint8Array.from([
            ...utf8('shieldvin:leaf:v0'), ...slotSalt,
            ...(name ? fieldKey(name) : new Uint8Array(32)), ...valueDigest
        ])));
    }
    const tree = buildTree(padToWidth(leaves, 32, () => b2b(utf8('shieldvin:pad'))), nodeHash);
    return Uint8Array.from(Buffer.from(tree.rootHex, 'hex'));
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
        sim.registerPassport(vin,
            contentRoot(intake.vin, intake.fields, intake.panel ?? {}),
            registrarId(intake.registrar)));
    if (intake.panel && Object.keys(intake.panel).length) {
        applied.push(`anchor panel: ${Object.keys(intake.panel).length} declaration fields in the content root (values stay private)`);
    }

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
        panel: {
            vehicleCategory: 'M1', fuelType: 'bev', emissionsClass: 'n/a',
            batteryPassportId: 'BPID-EU-000184-2027', batteryChemistry: 'NMC811',
            firstRegistrationDate: 20_240, co2FootprintKgCO2e: 8_400,
            recycledPlasticPct: 26.5, recycledSteelPct: 31.0
        },
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
        panel: { vehicleCategory: 'M1', fuelType: 'diesel', emissionsClass: 'Euro 5', firstRegistrationDate: 15_910 },
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
