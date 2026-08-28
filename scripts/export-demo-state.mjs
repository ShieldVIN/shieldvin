/**
 * Generate `site/verify/demo-data.json` and `site/verify/fields.json`.
 *
 * The demo data is NOT hand-written. It is the public ledger of the real
 * compiled contract after a scripted history, exported as JSON — so the scan
 * page renders exactly what an observer of the chain would see, nothing more.
 * Values and salts live only in this process and are not exported.
 *
 * The scenario itself lives in `lib/scenario.mjs`, shared with the intake
 * runner: a vehicle added through the console is built by exactly the code
 * that builds these two.
 *
 *   Vehicle A — a clean history with claims to show for it.
 *   Vehicle B — a passport whose clean-history proofs would abort in-circuit,
 *               so no such claims exist and the page must say "not proven".
 *
 * Run: npm run demo:export
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PassportSimulator, buildDemoVehicles, exportLedger, vocabulary, saltStream } from './lib/scenario.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'verify');

const sim = new PassportSimulator();
const { a, b } = buildDemoVehicles(sim, saltStream());

for (const [name, r] of [['A', a], ['B', b]]) {
    if (name === 'A' && r.refused.length) {
        throw new Error(`vehicle A must apply cleanly, refused: ${JSON.stringify(r.refused)}`);
    }
    console.log(`vehicle ${name}: ${r.applied.length} steps applied, ${r.refused.length} refused`);
}

const ledger = exportLedger(sim,
    'vinpassport, compiled circuits run locally by scripts/export-demo-state.mjs');

writeFileSync(join(OUT, 'demo-data.json'), JSON.stringify(ledger, null, 2) + '\n');
writeFileSync(join(OUT, 'fields.json'), JSON.stringify(vocabulary([
    { vinHash: a.vinHex, title: '2019 Golf, silver', battery: 'not an EV', blurb: 'Full service history, claims proven' },
    { vinHash: b.vinHex, title: '2018 320d, grey', battery: 'not an EV', blurb: 'A record it cannot prove clean' }
]), null, 2) + '\n');

console.log(`exported ${ledger.claims.length} claims, ${Object.keys(ledger.passports).length} passports -> site/verify/`);
