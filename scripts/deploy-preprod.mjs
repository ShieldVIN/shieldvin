/**
 * Deploy `shieldvin-passport` to Midnight preprod, fee paid by ODATANO's
 * sponsor. Implements the onboarding recipe: the transaction is built, proven
 * and signed HERE, with our key and our prover keys; the sponsor receives
 * only the unbound transaction bytes, pays the fee, and submits.
 *
 *   node scripts/deploy-preprod.mjs            build + prove, print the
 *                                              address, submit NOTHING
 *   node scripts/deploy-preprod.mjs --submit   actually spend a deploy
 *
 * Dry-run is the default because the grant allows TWO deploys, ever, and
 * `registerPassport` is insert-once per VIN — a redeploy starts from an empty
 * ledger. Nothing should be able to spend a deploy by accident.
 *
 * Environment (set in the shell, never in a file inside this repo):
 *   SHIELDVIN_SEED_HEX             128 hex chars. Our key. Never leaves the process.
 *   NIGHTGATE_AGENT_TOKEN          the grant token, sent to us privately
 *   NIGHTGATE_SPONSOR_SESSION_ID   the sponsor session the grant is pinned to
 *   NIGHTGATE_BASE_URL             optional, defaults to https://api.nightgate.dev
 *
 * On success the public record of the deployment is written to
 * `deploy/preprod.json` — address and transaction hash only, both public by
 * definition. Commit it: the scan page's live source and every verifier
 * instruction will point at it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { Contract } from '../contracts/shieldvin-passport/src/managed/shieldvin-passport/contract/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANAGED = join(ROOT, 'contracts', 'shieldvin-passport', 'src', 'managed', 'shieldvin-passport');
const SUBMIT = process.argv.includes('--submit');

const fail = (msg) => { console.error(`\nSTOP: ${msg}`); process.exit(1); };

// ---------------------------------------------------------------- preflight

const CIRCUITS = ['registerPassport', 'initialiseField', 'recordField', 'proveFieldAtMost', 'proveFieldAtLeast'];
for (const c of CIRCUITS) {
    if (!existsSync(join(MANAGED, 'keys', `${c}.prover`))) {
        fail(`missing prover key for ${c}. Keys are gitignored - run \`npm run compile\` in WSL first.`);
    }
}

const seed = process.env.SHIELDVIN_SEED_HEX ?? '';
if (!/^[0-9a-fA-F]{128}$/.test(seed)) {
    fail('SHIELDVIN_SEED_HEX must be 128 hex characters. Set it in the shell; never write it to a file in this repo.');
}
const token = process.env.NIGHTGATE_AGENT_TOKEN;
const sponsorSessionId = process.env.NIGHTGATE_SPONSOR_SESSION_ID;
if (!token || !sponsorSessionId) {
    fail('NIGHTGATE_AGENT_TOKEN and NIGHTGATE_SPONSOR_SESSION_ID are required (from the onboarding note).');
}
const baseUrl = process.env.NIGHTGATE_BASE_URL ?? 'https://api.nightgate.dev';

const outPath = join(ROOT, 'deploy', 'preprod.json');
if (existsSync(outPath) && SUBMIT) {
    fail(`deploy/preprod.json already exists - a contract is already deployed. ` +
        `The grant allows 2 deploys total and a redeploy is an EMPTY ledger. ` +
        `Delete the file first if a redeploy is genuinely intended.`);
}

// ---------------------------------------------------------------- build

console.log(`network   preprod`);
console.log(`sponsor   ${baseUrl} (session ${sponsorSessionId.slice(0, 8)}…)`);
console.log(`mode      ${SUBMIT ? 'SUBMIT - this spends 1 of 2 allowed deploys' : 'dry run - nothing leaves this machine'}`);
console.log('\nbuilding and proving the deploy locally (wasm, takes a while)…');

const builder = await createTxBuilder({
    seedHex: seed,
    networkId: 'preprod',
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    nodeUrl: 'wss://rpc.preprod.midnight.network/',
    contractClass: Contract,
    contractName: 'shieldvin-passport',
    privateStateId: 'shieldvin-passport',
    zkConfigDir: MANAGED
});

try {
    const deploy = await builder.buildDeploySponsorable({ initialPrivateState: {}, bind: false });
    console.log(`\ncontract address (known before submission): ${deploy.contractAddress}`);

    if (!SUBMIT) {
        console.log('\nDry run complete. The transaction was proven and signed but NOT submitted.');
        console.log('Re-run with --submit to spend a deploy.');
        process.exit(0);
    }

    const ng = connect({ baseUrl, agentToken: token });
    console.log('\nhanding the unbound transaction to the sponsor…');
    const job = await ng.sponsorUnbound({ unboundTxB64: deploy.unboundTxB64, sponsorSessionId });
    const out = await ng.waitForJob({ jobId: job.jobId, sessionId: sponsorSessionId });

    const landedAt = out.deployed?.[0];
    if (landedAt && landedAt !== deploy.contractAddress) {
        fail(`landed address ${landedAt} differs from the locally computed ${deploy.contractAddress} - do not record either; investigate.`);
    }

    mkdirSync(join(ROOT, 'deploy'), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
        network: 'preprod',
        contractAddress: deploy.contractAddress,
        txHash: out.txHash,
        contract: 'shieldvin-passport',
        note: 'Public record of the deployment. Address and tx hash are public by definition.'
    }, null, 2) + '\n');

    console.log(`\nDEPLOYED  ${deploy.contractAddress}`);
    console.log(`tx        ${out.txHash}`);
    console.log(`recorded  deploy/preprod.json - commit it.`);
} finally {
    await builder.close?.();
}
