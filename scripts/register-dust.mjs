/**
 * Register the demo wallet's NIGHT for dust generation.
 *
 * Dust pays every fee on Midnight and is not a balance you top up: it
 * regenerates from NIGHT UTXOs that are REGISTERED for generation. Holding
 * NIGHT is not enough. The demo wallet ran on a one-off dust grant with
 * nothing behind it, so when the grant ran out mid-run there was nothing to
 * refill it - four stages of a passport on chain and no fee left for the
 * fifth.
 *
 * The registration pays for itself, which is the part worth understanding:
 * an UNREGISTERED Night UTXO still trickles dust during the grace period,
 * and that trickle is what funds the registration transaction. So on a wallet
 * with zero dust the order is: wait for the trickle to cover the fee, then
 * register, and from then on generation runs at the full rate.
 *
 *   node scripts/register-dust.mjs            # report only, changes nothing
 *   node scripts/register-dust.mjs --register # actually register
 *
 * Run it with the demo service STOPPED: restoring a wallet is heavy
 * synchronous work and the box does not have room for two of them.
 *
 *   systemctl stop vinpassport-demo
 *   VINPASSPORT_SEED_FILE=... VINPASSPORT_STATE_DIR=... node scripts/register-dust.mjs --register
 *   systemctl start vinpassport-demo
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { makeWasmProvingService } from '@midnightntwrk/wallet-sdk-capabilities';
import { ZswapSecretKeys, DustSecretKey, LedgerParameters } from '@midnight-ntwrk/ledger-v8';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK_ID = process.env.VINPASSPORT_NETWORK_ID ?? 'preprod';
const INDEXER_HTTP = process.env.VINPASSPORT_INDEXER_HTTP ?? 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = process.env.VINPASSPORT_INDEXER_WS ?? 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const NODE_WS = process.env.VINPASSPORT_NODE_WS ?? 'wss://rpc.preprod.midnight.network';
const NODE_HTTP = process.env.VINPASSPORT_NODE_HTTP ?? 'https://rpc.preprod.midnight.network';

const DO_IT = process.argv.includes('--register');
const log = (...a) => console.log(...a);

const seedFile = process.env.VINPASSPORT_SEED_FILE;
const stateDir = process.env.VINPASSPORT_STATE_DIR;
if (!seedFile || !stateDir) throw new Error('needs VINPASSPORT_SEED_FILE and VINPASSPORT_STATE_DIR');
const seedHex = readFileSync(seedFile, 'utf8')
    .split(/\r?\n/).find((l) => l.startsWith('VINPASSPORT_SEED_HEX='))?.slice(21).trim();
if (!seedHex || seedHex.length !== 128) throw new Error('seed file does not hold VINPASSPORT_SEED_HEX=<128 hex>');

const hd = HDWallet.fromSeed(new Uint8Array(Buffer.from(seedHex, 'hex')));
const account = hd.hdWallet.selectAccount(0);
const roleSeed = (r) => account.selectRole(r).deriveKeyAt(0).key;
const zswapKeys = ZswapSecretKeys.fromSeed(roleSeed(Roles.Zswap));
const dustKey = DustSecretKey.fromSeed(roleSeed(Roles.Dust));
const keystore = createKeystore(roleSeed(Roles.NightExternal), NETWORK_ID);
hd.hdWallet.clear();

const blobPath = (n) => join(stateDir, n + '.blob');
const loadBlob = (n) => existsSync(blobPath(n)) ? readFileSync(blobPath(n), 'utf8') : null;
const saveBlob = (n, d) => { const t = blobPath(n) + '.tmp'; writeFileSync(t, d); renameSync(t, blobPath(n)); };
const restore = { shielded: loadBlob('shielded'), unshielded: loadBlob('unshielded'), dust: loadBlob('dust') };

const configuration = {
    indexer: { url: INDEXER_HTTP, wsUrl: INDEXER_WS },
    node: { url: NODE_HTTP, wsUrl: NODE_WS },
    networkId: NETWORK_ID,
    transactionHistoryStorage: new InMemoryTransactionHistoryStorage()
};

log(`network ${NETWORK_ID}`);
log(`address ${PublicKey.fromKeyStore(keystore).address}`);
log(DO_IT ? 'mode    REGISTER (this writes a transaction)' : 'mode    report only (pass --register to write)\n');

const facade = await WalletFacade.init({
    configuration,
    provingService: () => makeWasmProvingService(),
    shielded: () => restore.shielded ? ShieldedWallet(configuration).restore(restore.shielded)
        : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
    unshielded: () => restore.unshielded ? UnshieldedWallet(configuration).restore(restore.unshielded)
        : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: () => restore.dust ? DustWallet(configuration).restore(restore.dust)
        : DustWallet(configuration).startWithSecretKey(dustKey, LedgerParameters.initialParameters().dust)
});
await facade.start(zswapKeys, dustKey);

// Give the unshielded wallet a moment to catch up: a NIGHT UTXO that arrived
// while the wallet was down is exactly the case this script exists for.
const settleMs = Number(process.env.VINPASSPORT_SETTLE_MS ?? 90_000);
log(`waiting ${Math.round(settleMs / 1000)}s for the wallet to see the chain...`);
await new Promise((r) => setTimeout(r, settleMs));

const now = () => new Date();
const utxos = [...(facade.unshielded.totalCoins ?? [])];
const dustNow = facade.dust.balance(now());
const balances = facade.unshielded.balances ?? {};
const nightTotal = Object.values(balances).reduce((a, v) => a + BigInt(v), 0n);

log(`\nNIGHT   ${nightTotal} across ${utxos.length} utxo(s)`);
log(`DUST    ${dustNow}`);
for (const [token, v] of Object.entries(balances)) log(`  token ${String(token).slice(0, 20)}… ${v}`);

if (!utxos.length) {
    log('\nNo NIGHT in this wallet, so there is nothing to register.');
    log('Send tNIGHT to the address above first; it must be the unshielded (mn_addr_) address.');
    await facade.stop().catch(() => { });
    process.exit(1);
}

// What the registration itself will cost, and how the unregistered UTXOs are
// already trickling dust towards it.
const est = await facade.estimateRegistration(utxos);
log(`\nregistration fee        ${est.fee} SPECKs`);
for (const d of est.dustGenerationEstimations ?? []) {
    try { log('  ' + JSON.stringify(d, (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 300)); }
    catch { /* opaque wasm object */ }
}

const already = utxos.filter((u) => u?.registeredForDustGeneration).length;
log(`\nalready registered      ${already} of ${utxos.length}`);
if (already === utxos.length) {
    log('Every NIGHT utxo is already generating dust. Nothing to do.');
    await facade.stop().catch(() => { });
    process.exit(0);
}

if (!DO_IT) {
    log('\nReport only. Re-run with --register to register these utxos for dust generation.');
    await facade.stop().catch(() => { });
    process.exit(0);
}

// The registration pays its own fee out of the trickle the unregistered UTXO
// is already producing, so wait for that to cover it rather than failing.
if (est.fee > dustNow) {
    const waitMs = Number(process.env.VINPASSPORT_DUST_WAIT_MS ?? 45 * 60_000);
    log(`\ndust ${dustNow} is short of the ${est.fee} fee; waiting up to ${Math.round(waitMs / 60000)} minutes`);
    log('(an unregistered utxo still generates during the grace period - that is what pays for this)');
    await facade.waitForGeneratedDust(utxos, est.fee, { timeoutMs: waitMs });
    log(`dust now ${facade.dust.balance(now())}`);
}

log('\nbuilding the registration...');
const recipe = await facade.registerNightUtxosForDustGeneration(
    utxos,
    keystore.getPublicKey(),
    (payload) => keystore.signData(payload)
);
// The dust registration signature is attached above; the unshielded offers are
// signed on their own path, which signRecipe drives with the same key.
const signed = await facade.signRecipe(recipe, (data) => keystore.signData(data));
const finalized = await facade.finalizeRecipe(signed);

log('submitting...');
const { ApiPromise, HttpProvider } = await import('@polkadot/api');
const { u8aToHex } = await import('@polkadot/util');
const api = await ApiPromise.create({ provider: new HttpProvider(NODE_HTTP), noInitWarn: true });
let hash;
try {
    const hex = api.tx.midnight.sendMnTransaction(u8aToHex(finalized.serialize())).toHex();
    hash = await new Promise((resolve, reject) => {
        const ws = new WebSocket(NODE_WS);
        const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error('submit timeout')); }, 60_000);
        ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [hex] }));
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id !== 1) return;
            clearTimeout(timer); try { ws.close(); } catch { }
            if (m.error) reject(new Error(`node rejected: ${m.error.code} ${m.error.message}${m.error.data ? ' | ' + JSON.stringify(m.error.data) : ''}`));
            else resolve(String(m.result));
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    });
} finally { await api.disconnect().catch(() => { }); }

log(`submitted: ${hash}`);
log('\nSaving wallet snapshots so the demo service starts from this state.');
saveBlob('shielded', await facade.shielded.serializeState());
saveBlob('unshielded', await facade.unshielded.serializeState());
saveBlob('dust', await facade.dust.serializeState());
writeFileSync(join(stateDir, 'meta.json'), JSON.stringify({ savedAt: new Date().toISOString(), reason: 'dust-registration' }, null, 2));

log('\nRegistered. Dust now generates from this NIGHT and refills on its own.');
log('It charges to full over about 7 days; a run needs roughly 5.1e15 SPECKs.');
await facade.stop().catch(() => { });
