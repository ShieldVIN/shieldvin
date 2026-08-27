/**
 * Generate `app/scan/demo-data.json` and `app/scan/fields.json`.
 *
 * The demo data is NOT hand-written. It is the public ledger of the real
 * compiled contract after a scripted history, exported as JSON — so the scan
 * page renders exactly what an observer of the chain would see, nothing more.
 * Values and salts live only in this process and are not exported; if they
 * leaked into the file, the page would be demonstrating a lie.
 *
 * Two vehicles, deliberately different:
 *
 *   Vehicle A — a clean history with claims to show for it. Registered, four
 *   services recorded, and four proofs made: never written off, no reported
 *   accidents, one keeper, mileage under 150 000 km.
 *
 *   Vehicle B — a passport with history but WITHOUT the clean-history claims.
 *   Its write-off category is 1 and its accident count is 2, so those proofs
 *   at bound 0 would abort in-circuit and write nothing. The page must show
 *   "not proven" rather than inventing a verdict; absence of a claim is the
 *   honest state, and this vehicle exists to exercise it.
 *
 * Run: npm run demo:export
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PassportSimulator, Rule, fieldKey, bytes32, hex } from '../test/passport-simulator.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'scan');

// ---------------------------------------------------------------- vocabulary

// The panel fields this demo exercises, with what the page needs to render
// them. Keys are the REAL derivation — blake2b-256 of the field name, exactly
// as @odatano/dpp-sdk derives them — so nothing here is invented either.
const FIELDS = {
    odometerKm:       { label: 'Mileage',           kind: 'km',       rule: Rule.neverFalls },
    accidentCount:    { label: 'Reported accidents', kind: 'count',   rule: Rule.neverFalls },
    ownerCount:       { label: 'Keepers',            kind: 'count',   rule: Rule.neverFalls },
    writeOffCategory: { label: 'Write-off category', kind: 'category', rule: Rule.neverFalls },
    serviceCount:     { label: 'Services recorded',  kind: 'count',   rule: Rule.neverFalls }
};

const K = Object.fromEntries(Object.keys(FIELDS).map((n) => [n, fieldKey(n)]));

// A vehicle is addressed by the hash of its VIN, never the VIN itself. The
// demo VINs are format-plausible and belong to no real vehicle.
const vinHash = (vin) => fieldKey(vin);
const VIN_A = vinHash('WVWZZZ1JZXW000001');
const VIN_B = vinHash('WAUZZZ8V5KA000002');

const REGISTRAR = fieldKey('shieldvin:registrar:demo-authority');

// ---------------------------------------------------------------- history

const sim = new PassportSimulator();
let saltN = 0;
const salt = () => bytes32(++saltN);

// --- Vehicle A: clean, and proven so -----------------------------------
sim.registerPassport(VIN_A, bytes32(0xa1), REGISTRAR);
sim.initialiseField(VIN_A, K.odometerKm, Rule.neverFalls, 18_430n, salt());
sim.initialiseField(VIN_A, K.accidentCount, Rule.neverFalls, 0n, salt());
sim.initialiseField(VIN_A, K.ownerCount, Rule.neverFalls, 1n, salt());
sim.initialiseField(VIN_A, K.writeOffCategory, Rule.neverFalls, 0n, salt());
sim.initialiseField(VIN_A, K.serviceCount, Rule.neverFalls, 1n, salt());

// services over the years — each one a proof the caller knew the last value
for (const [km, services] of [[44_210n, 2n], [61_890n, 3n], [83_260n, 4n]]) {
    sim.recordField(VIN_A, K.odometerKm, km, salt());
    sim.recordField(VIN_A, K.serviceCount, services, salt());
}

// the claims a buyer actually asks for, proven against the CURRENT state
sim.proveFieldAtMost(VIN_A, K.writeOffCategory, 0n);
sim.proveFieldAtMost(VIN_A, K.accidentCount, 0n);
sim.proveFieldAtMost(VIN_A, K.ownerCount, 1n);
sim.proveFieldAtMost(VIN_A, K.odometerKm, 150_000n);

// --- Vehicle B: a record it cannot prove clean -------------------------
sim.registerPassport(VIN_B, bytes32(0xb2), REGISTRAR);
sim.initialiseField(VIN_B, K.odometerKm, Rule.neverFalls, 96_500n, salt());
sim.initialiseField(VIN_B, K.accidentCount, Rule.neverFalls, 2n, salt());
sim.initialiseField(VIN_B, K.ownerCount, Rule.neverFalls, 3n, salt());
sim.initialiseField(VIN_B, K.writeOffCategory, Rule.neverFalls, 1n, salt());
sim.recordField(VIN_B, K.odometerKm, 112_040n, salt());

// The clean-history proofs would abort in-circuit for B — prove what is true
// instead. The page's job is to render the difference honestly.
sim.proveFieldAtMost(VIN_B, K.odometerKm, 200_000n);

// ---------------------------------------------------------------- export

const l = sim.ledger;
const mapToObj = (m, val) => {
    const out = {};
    for (const [k, v] of m) out[hex(k)] = val(v);
    return out;
};

const claims = [];
for (const [key, c] of l.claims) {
    claims.push({
        key: hex(key),
        slot: hex(c.slot),
        vinHash: hex(c.vinHash),
        fieldKey: hex(c.fieldKey),
        commitment: hex(c.commitment),
        bound: c.bound.toString(),
        atMost: c.atMost
    });
}

const ledgerJson = {
    source: 'shieldvin-passport, compiled circuits run locally by scripts/export-demo-state.mjs',
    note: 'Real public ledger state. Values and salts never leave the generating process.',
    passports: mapToObj(l.passports, hex),
    registrar: mapToObj(l.registrar, hex),
    fieldCommitment: mapToObj(l.fieldCommitment, hex),
    fieldRule: mapToObj(l.fieldRule, (r) => Number(r)),
    claims,
    updateCount: l.updateCount.toString()
};

const fieldsJson = {
    note: 'Public vocabulary: blake2b-256(field name) -> display metadata. See docs/FIELDS.md.',
    fields: Object.fromEntries(
        Object.entries(FIELDS).map(([name, meta]) => [
            hex(K[name]), { name, label: meta.label, kind: meta.kind }
        ])
    ),
    demoVehicles: [
        { vinHash: hex(VIN_A), title: 'Vehicle A', blurb: 'Full service history, claims proven' },
        { vinHash: hex(VIN_B), title: 'Vehicle B', blurb: 'A record it cannot prove clean' }
    ]
};

writeFileSync(join(OUT, 'demo-data.json'), JSON.stringify(ledgerJson, null, 2) + '\n');
writeFileSync(join(OUT, 'fields.json'), JSON.stringify(fieldsJson, null, 2) + '\n');
console.log(`exported ${claims.length} claims, ${Object.keys(ledgerJson.passports).length} passports -> app/scan/`);
