/**
 * Run an intake file — produced by the console page at app/console/ — through
 * the real compiled circuits, and regenerate the scan page's ledger with the
 * new vehicle in it.
 *
 *   node scripts/intake.mjs private/my-vehicle.json
 *
 * The intake file holds the ACTUAL VALUES and the VIN, which is why it
 * belongs in `private/` (gitignored) and must never be committed: the whole
 * design is that values stay on the operator's machine while only commitments
 * and claims reach the exported ledger.
 *
 * Refusals are results: an update that breaks a field's rule, or a claim the
 * state cannot support, is refused by the circuit, reported here, and writes
 * nothing — exactly as on chain.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
    PassportSimulator, buildDemoVehicles, applyIntake, exportLedger, vocabulary, saltStream
} from './lib/scenario.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'scan');

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/intake.mjs <intake.json>   (keep intake files in private/)');
    process.exit(1);
}
const path = resolve(file);
if (!path.includes('private') ) {
    console.warn('NOTE: intake files hold real values and the VIN - keep them under private/ (gitignored).');
}

let intake;
try {
    intake = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
    console.error(`could not read intake file: ${e.message}`);
    process.exit(1);
}
for (const req of ['vin', 'registrar', 'fields']) {
    if (!intake[req]) { console.error(`intake file is missing "${req}"`); process.exit(1); }
}

// One simulator run holds the whole exported world: the two standing demo
// vehicles plus this intake. Rebuilding from scratch keeps the export a pure
// function of its inputs.
const sim = new PassportSimulator();
const salt = saltStream();
const { a, b } = buildDemoVehicles(sim, salt);
const mine = applyIntake(sim, intake, salt);

console.log(`\nvehicle ${intake.vin} -> vin hash ${mine.vinHex}`);
for (const step of mine.applied) console.log(`  ok       ${step}`);
for (const r of mine.refused) console.log(`  REFUSED  ${r.step} - ${r.reason}`);
if (mine.refused.length) {
    console.log('\nRefused steps wrote nothing, exactly as they would on chain.');
}

const ledger = exportLedger(sim,
    'vinpassport, compiled circuits run locally by scripts/intake.mjs');
writeFileSync(join(OUT, 'demo-data.json'), JSON.stringify(ledger, null, 2) + '\n');
writeFileSync(join(OUT, 'fields.json'), JSON.stringify(vocabulary([
    { vinHash: a.vinHex, title: 'Vehicle A', blurb: 'Full service history, claims proven' },
    { vinHash: b.vinHex, title: 'Vehicle B', blurb: 'A record it cannot prove clean' },
    { vinHash: mine.vinHex, title: intake.label || 'Your vehicle', blurb: 'Added through the intake console' }
]), null, 2) + '\n');

console.log(`\nledger regenerated with ${ledger.claims.length} claims across 3 passports.`);
console.log(`view it:  npm run serve:site  ->  /verify/?v=${mine.vinHex}`);
console.log('(the exported ledger holds commitments and claims - never your values or the VIN)');
