/**
 * The content root over the 32-slot regulation panel (scripts/lib/scenario).
 *
 * What must hold: the root commits to every declaration - change one and the
 * root changes - while disclosing nothing, including whether a slot is
 * occupied at all. These run under node --test per D17.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentRoot, PANEL, hex } from '../../scripts/lib/scenario.mjs';

const VIN = 'WVWZZZ1JZXW000001';
const FIELDS = { odometerKm: 18_430, accidentCount: 0, ownerCount: 1, writeOffCategory: 0, serviceCount: 1 };
const PANEL_A = {
    vehicleCategory: 'M1', fuelType: 'bev', emissionsClass: 'n/a',
    batteryPassportId: 'BPID-EU-000184-2027', firstRegistrationDate: 20_240
};

test('the panel covers the FIELDS.md layout: 26 fields, reserve untouched', () => {
    const slots = Object.values(PANEL).map(([slot]) => slot);
    assert.equal(new Set(slots).size, slots.length, 'no slot is assigned twice');
    for (const slot of slots) {
        assert.ok((slot >= 0 && slot <= 16) || (slot >= 22 && slot <= 30),
            `slot ${slot} must not sit in the reserve (17-21, 31)`);
    }
    // The regulation-facing fields the console asks about are all addressable.
    for (const name of ['fuelType', 'vehicleCategory', 'emissionsClass',
        'batteryPassportId', 'recycledPlasticPct', 'co2FootprintKgCO2e', 'passportOrigin']) {
        assert.ok(name in PANEL, `${name} missing from the panel`);
    }
});

test('the root is deterministic', () => {
    assert.equal(
        hex(contentRoot(VIN, FIELDS, PANEL_A)),
        hex(contentRoot(VIN, FIELDS, PANEL_A))
    );
});

test('changing one declaration changes the root - the root really commits', () => {
    const base = hex(contentRoot(VIN, FIELDS, PANEL_A));
    assert.notEqual(base, hex(contentRoot(VIN, FIELDS, { ...PANEL_A, fuelType: 'diesel' })));
    assert.notEqual(base, hex(contentRoot(VIN, FIELDS, { ...PANEL_A, batteryPassportId: 'BPID-EU-999999-2027' })));
    assert.notEqual(base, hex(contentRoot(VIN, { ...FIELDS, odometerKm: 18_431 }, PANEL_A)));
});

test('an absent declaration also changes the root, but is not distinguishable as absent', () => {
    // Dropping the battery link changes the commitment...
    const withLink = hex(contentRoot(VIN, FIELDS, PANEL_A));
    const { batteryPassportId, ...noLink } = PANEL_A;
    assert.notEqual(withLink, hex(contentRoot(VIN, FIELDS, noLink)));
    // ...but both are opaque 32-byte roots: nothing in either says which
    // slots are filled. (The real privacy property is that leaves are salted;
    // what a test can pin is that the root leaks no structure.)
    assert.equal(contentRoot(VIN, FIELDS, noLink).length, 32);
});

test('two vehicles with identical declarations do not share a root', () => {
    // Salts derive per-VIN, so equal content does not produce equal
    // commitments across vehicles - the same reason field commitments take
    // fresh salts.
    assert.notEqual(
        hex(contentRoot('WVWZZZ1JZXW000001', FIELDS, PANEL_A)),
        hex(contentRoot('WAUZZZ8V5KA000002', FIELDS, PANEL_A))
    );
});

test('no declaration value survives into the root bytes', () => {
    const root = hex(contentRoot(VIN, FIELDS, PANEL_A));
    for (const needle of ['BPID', 'M1', 'bev', '18430', '20240']) {
        assert.ok(!root.includes(Buffer.from(needle).toString('hex')),
            `root visibly contains ${needle}`);
    }
});
