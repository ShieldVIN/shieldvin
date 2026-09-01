/**
 * The preprod demo engine: runs a REAL intake against the DEPLOYED vinpassport
 * contract on Midnight preprod, self-funded from our own wallet.
 *
 * This is the productized form of the two proven spikes (spike-call-build +
 * fund-and-submit): per run it plans the intake into batched contract calls,
 * pre-simulates them locally so in-circuit refusals are caught and REPORTED
 * rather than submitted, proves each batch in-process (wasm), pays the dust
 * fee with the wallet this process holds, submits over one-shot WebSocket
 * JSON-RPC (the HTTP gateway 403s bodies over ~14KB), and watches the indexer
 * until the call is on chain. The caller gets a receipt file holding the
 * values and salts - the private half of the passport - which never leave
 * this process any other way.
 *
 * preprod-plan.mjs holds the two rules this engine cannot get wrong: how calls
 * pack into transactions, and why per-call witness state must be armed.
 *
 * Demo policy (locked design): a GLOBAL cap of runs per UTC day, guided and
 * manual counted together; every run uses a fresh random VPD-prefixed VIN so
 * demos never collide with each other or with real vehicles.
 *
 * Requires (never committed, never sent to the client):
 *   VINPASSPORT_SEED_FILE   file containing VINPASSPORT_SEED_HEX=<128 hex>
 *   VINPASSPORT_STATE_DIR   dir with {shielded,unshielded,dust}.blob snapshots
 *   VINPASSPORT_DEMO_CAP    optional, default 5
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2';
import {
    createTxBuilder, submitExtrinsic,
    classifyNodeReject, isPreMempoolReject, isTransportFailure, isAlreadyImported
} from '@odatano/nightgate-tx/txbuilder';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { makeWasmProvingService } from '@midnightntwrk/wallet-sdk-capabilities';
import { ZswapSecretKeys, DustSecretKey, Transaction } from '@midnight-ntwrk/ledger-v8';
import { Contract } from '../../contracts/vinpassport/src/managed/vinpassport/contract/index.js';
import {
    PassportSimulator, hex,
    FIELDS, K, vinHash as vinHashOf, contentRoot, registrarId, PANEL
} from './scenario.mjs';
import {
    CLAIM_DEFS, planCalls, makeStage, stepLabel, makeWitnessHolder, randomDemoVin
} from './preprod-plan.mjs';

export { randomDemoVin };

/**
 * May a contract-call proof made when the contract's latest action was
 * `atBuild` still be submitted now that its latest action is `now`?
 *
 * Returns `null` when it may, and otherwise the reason it may not - so the
 * caller can say why it is about to spend another 30-100s proving.
 *
 * The call carries a transcript that has to replay against the contract's
 * current state, and a call that lands and FAILS costs its fee exactly like
 * one that succeeds. So this answers "reusable" only on positive evidence
 * that nothing moved. Not knowing is not the same as nothing having changed:
 * an indexer that fails to answer, or a contract with no recorded action at
 * either end, both mean rebuild.
 */
export function proofReusable(atBuild, now) {
    if (atBuild?.hash == null) return 'the contract had no recorded action when the call was proven';
    if (now?.hash == null) return 'the indexer did not say what the contract\'s latest action is';
    if (now.hash !== atBuild.hash) return `the contract moved on to ${now.hash}`;
    return null;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NETWORK_ID = 'preprod';
const NODE_HTTP = 'https://rpc.preprod.midnight.network';
const NODE_WS = 'wss://rpc.preprod.midnight.network/';
const INDEXER_HTTP = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const ZK_CONFIG_DIR = join(ROOT, 'contracts', 'vinpassport', 'src', 'managed', 'vinpassport');
// Time budgets.
//
// These used to be incoherent with each other. The run ceiling was a flat 20
// minutes however many stages the intake produced, while confirmation alone
// was allowed 4 minutes per stage - so a five-stage run could spend its whole
// ceiling waiting on the indexer and time out on a run that had in fact
// worked. Measured on preprod 2026-08-31: a clean five-stage run used ~18
// minutes of the 20, so one slow block or a single retry would have reported
// a passing run as a timeout.
//
// The budget now comes from the plan instead of a guess: every stage gets its
// own deadline, and the run's ceiling is derived from how many stages there
// are. The outer backstop only catches something pathological.
const CONFIRM_TIMEOUT_MS = 240_000;   // indexer lag is real; keep this net wide
// Matched to block time. Nearly all the latency the old loop added came from
// sleeping BEFORE its first look, not from the cadence, so polling faster than
// blocks arrive only spends someone else's indexer: at 4s a 90s confirm cost
// 24 requests against 16 here, to save about a second.
const CONFIRM_POLL_MS = 6_000;
const GATE_TIMEOUT_MS = 3 * 60_000;   // a wallet 3 minutes behind is a fault, not a wait
const WARMUP_BUDGET_MS = 7 * 60_000;  // restore, dry-run and the first build
const STAGE_BUDGET_MS = 8 * 60_000;   // build + fund + submit + confirm, including retries
const JOB_CEILING_MS = 75 * 60_000;   // backstop only; the real bound is per stage
// What a whole run needs in the wallet before it is worth starting. Left at 0
// deliberately: the real per-stage cost is not something to invent, and a
// wrong floor would refuse runs that would have worked. The status endpoint
// reports the balance now, so set VINPASSPORT_MIN_DUST once a few runs have
// shown what one actually costs. A zero balance is refused regardless, since
// that needs no threshold to be certain about.
const MIN_DUST = BigInt(process.env.VINPASSPORT_MIN_DUST ?? 0);

const b2b = (d) => blake2b(d, { dkLen: 32 });
const utf8 = (s) => new TextEncoder().encode(s);
const zero32 = () => new Uint8Array(32);

// ---------------------------------------------------------------- the runner

export async function createRunner({ log = console.log } = {}) {
    // ---- secrets and paths, from the environment only ----------------------
    const seedFile = process.env.VINPASSPORT_SEED_FILE;
    const stateDir = process.env.VINPASSPORT_STATE_DIR;
    if (!seedFile || !stateDir) throw new Error('preprod demo needs VINPASSPORT_SEED_FILE and VINPASSPORT_STATE_DIR');
    const seedHex = readFileSync(seedFile, 'utf8')
        .split(/\r?\n/).find((l) => l.startsWith('VINPASSPORT_SEED_HEX='))?.slice(21).trim();
    if (!seedHex || seedHex.length !== 128) throw new Error('seed file does not hold VINPASSPORT_SEED_HEX=<128 hex>');
    const contractAddress = JSON.parse(readFileSync(join(ROOT, 'deploy', 'preprod.json'), 'utf8')).contractAddress;
    const capacity = Number(process.env.VINPASSPORT_DEMO_CAP ?? 5);

    // ---- wallet keys -------------------------------------------------------
    const hd = HDWallet.fromSeed(new Uint8Array(Buffer.from(seedHex, 'hex')));
    const account = hd.hdWallet.selectAccount(0);
    const roleSeed = (r) => account.selectRole(r).deriveKeyAt(0).key;
    const zswapKeys = ZswapSecretKeys.fromSeed(roleSeed(Roles.Zswap));
    const dustKey = DustSecretKey.fromSeed(roleSeed(Roles.Dust));
    const keystore = createKeystore(roleSeed(Roles.NightExternal), NETWORK_ID);
    hd.hdWallet.clear();

    // ---- facade from snapshots, kept alive for the process lifetime --------
    const blobPath = (n) => join(stateDir, n + '.blob');
    const loadBlob = (n) => existsSync(blobPath(n)) ? readFileSync(blobPath(n), 'utf8') : null;
    const saveBlob = (n, data) => {
        const tmp = blobPath(n) + '.tmp';
        writeFileSync(tmp, data);
        renameSync(tmp, blobPath(n));
    };
    // ---- one process per wallet, enforced ----------------------------------
    //
    // Exactly one process may hold a wallet. The port check in app-server
    // covers the usual case; this covers the rest, including a script pointed
    // at the same VINPASSPORT_STATE_DIR. Snapshots are written atomically
    // against a partial write, which is not the same as against a neighbour.
    //
    // A stale lock from a killed process must not brick the demo, so the lock
    // records a pid and is taken over when that pid is gone.
    const lockPath = join(stateDir, 'runner.lock');
    (function takeLock() {
        const mine = JSON.stringify({ pid: process.pid, since: new Date().toISOString() });
        try {
            writeFileSync(lockPath, mine, { flag: 'wx' });
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let held = null;
            try { held = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* unreadable = stale */ }
            const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
            if (held?.pid && held.pid !== process.pid && alive(held.pid)) {
                throw new Error(
                    `another process (pid ${held.pid}, since ${held.since}) is already using ${stateDir}. ` +
                    'Exactly one process may hold a wallet; stop that one first.');
            }
            log(`demo: taking over a stale lock from pid ${held?.pid ?? 'unknown'}`);
            writeFileSync(lockPath, mine);
        }
    })();
    const dropLock = () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    process.once('exit', dropLock);
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, () => { dropLock(); process.exit(0); });
    }

    const restore = { shielded: loadBlob('shielded'), unshielded: loadBlob('unshielded'), dust: loadBlob('dust') };
    if (!restore.dust) throw new Error(`no dust snapshot in ${stateDir}; run the dust sync first`);

    const configuration = {
        networkId: NETWORK_ID,
        provingServerUrl: new URL('http://127.0.0.1:6300'),
        relayURL: new URL(NODE_WS),
        indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };

    let facade = null;
    let ready = false;
    let warmError = null;
    const dust = { applied: -1n, tip: -1n };

    const peek = () => new Promise((res) => {
        let sub; const t = setTimeout(() => { if (sub) sub.unsubscribe(); res(null); }, 15000);
        try {
            sub = facade.state().subscribe({
                next: (v) => { clearTimeout(t); if (sub) sub.unsubscribe(); res(v); },
                error: () => { clearTimeout(t); res(null); }
            });
        } catch { clearTimeout(t); res(null); }
    });

    const dustStreamTip = () => new Promise((resolve) => {
        let settled = false; let ws;
        const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch { } resolve(v); } };
        ws = new WebSocket(INDEXER_WS, 'graphql-transport-ws');
        const timer = setTimeout(() => done(null), 10000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.type === 'connection_ack') {
                ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription { dustLedgerEvents(id: 0) { id maxId } }' } }));
            } else if (m.type === 'next') {
                clearTimeout(timer);
                const d = m.payload?.data?.dustLedgerEvents;
                done(d && d.maxId != null ? d.maxId : null);
            }
        };
        ws.onerror = () => { clearTimeout(timer); done(null); };
    });

    /**
     * Warm-up gate. The tip moves constantly, so demanding equality here would
     * spin forever; a hundred events of slack is fine for deciding the wallet
     * has finished restoring.
     */
    async function gateToTip(ceilingMs) {
        const end = Date.now() + ceilingMs;
        for (; ;) {
            if (Date.now() > end) throw new Error('dust catch-up did not reach the chain tip in time');
            const [st, tip] = await Promise.all([peek(), dustStreamTip()]);
            dust.applied = st?.dust?.progress?.appliedIndex != null ? BigInt(st.dust.progress.appliedIndex) : -1n;
            if (tip != null) dust.tip = BigInt(tip);
            if (dust.tip > 0n && dust.applied >= 0n && dust.applied >= dust.tip - 100n) return;
            await new Promise((r) => setTimeout(r, 10_000));
        }
    }

    /**
     * Between-stage gate, and it must be strict where the warm-up one is not.
     *
     * A dust spend is proven against the dust Merkle root the wallet believes
     * in. Run four stages and the wallet drifts behind while each proof takes
     * the better part of a minute, so by stage five it is proving against a
     * root the node has moved past and the node rejects the transaction. That
     * is the shape of the run that died here: stages one to four landed, the
     * wallet sat 67 events behind the tip, and every attempt after that was
     * refused. Slack is exactly the wrong thing to allow at this point.
     *
     * The tip is sampled ONCE and used as a fixed target, so this terminates:
     * waiting for a tip that keeps advancing would never finish.
     */
    async function gateToApplied(ceilingMs, signal) {
        const end = Date.now() + ceilingMs;
        const target = await dustStreamTip();
        if (target == null) return;                    // indexer quiet; do not block the run
        const want = BigInt(target);
        for (; ;) {
            const st = await peek();
            dust.applied = st?.dust?.progress?.appliedIndex != null ? BigInt(st.dust.progress.appliedIndex) : -1n;
            if (dust.applied >= want) { dust.tip = want > dust.tip ? want : dust.tip; return; }
            if (Date.now() > end) {
                throw new Error(`the wallet is ${want - dust.applied} dust events behind the chain; ` +
                    'a fee proven against a stale dust root is rejected by the node');
            }
            // A cancelled run must not sit here for the rest of the ceiling:
            // this loop can outlive the queue's grace period on its own.
            if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
            await new Promise((r) => setTimeout(r, 5_000));
        }
    }

    /**
     * What the wallet can actually pay with, right now.
     *
     * Dust is wallet-local by design: the indexer has no per-address query for
     * it, so if the service does not report this number nobody can see it
     * until a run dies of it. Which is exactly what happened - four stages
     * landed, the fifth was rejected 1010/170, and only the local balancer
     * further down said "Insufficient Funds: could not balance dust".
     */
    // Balances live on the wallet STATE objects the facade emits, not on the
    // wallet handles themselves: `facade.dust.balance` and
    // `facade.unshielded.balances` are both undefined, so reading them
    // reported a confident zero for a wallet holding 12e9 NIGHT. Keep the
    // latest emitted state and read balances off that.
    let latest = null;
    const watchState = () => {
        try { facade.state().subscribe({ next: (v) => { latest = v; }, error: () => { } }); }
        catch (e) { log('demo: state subscription failed:', e?.message ?? e); }
    };

    function dustBalance() {
        try {
            const b = latest?.dust?.balance;
            return typeof b === 'function' ? BigInt(latest.dust.balance(new Date())) : null;
        } catch { return null; }
    }

    /**
     * Dust, the NIGHT behind it, and whether that NIGHT is actually generating.
     *
     * Dust is not a balance you top up directly: it regenerates from NIGHT
     * UTXOs REGISTERED for dust generation. Holding NIGHT is not enough. So
     * "how much dust" is only half the question, and the half that does not
     * tell you whether it will ever come back.
     */
    function walletFunds() {
        const out = { dust: null, night: null, nightUtxos: null, available: null, pending: null, registered: null };
        if (!latest) { out.note = 'no wallet state emitted yet'; return out; }
        try { const d = dustBalance(); out.dust = d == null ? null : d.toString(); } catch { }
        try {
            const u = latest.unshielded;
            const bal = u?.balances ?? {};
            out.night = Object.values(bal).reduce((a, v) => a + BigInt(v), 0n).toString();
            out.nightUtxos = (u?.totalCoins ?? []).length;
            // Dust the balancer cannot reach is the interesting number: a
            // rejected submission leaves its atoms pending, and a wallet with
            // a healthy balance and nothing available fails to balance exactly
            // like an empty one.
            out.available = (u?.availableCoins ?? []).length;
            out.pending = (u?.pendingCoins ?? []).length;
            // The flag sits on the utxo's META, not on the utxo: totalCoins
            // yields UtxoWithMeta = { utxo, meta }, and `meta` is where
            // registeredForDustGeneration lives. Reading it one level too high
            // gave `undefined` for every coin and therefore a confident
            // "registered: 0" for nine UTXOs the chain says ARE registered.
            //
            // Which is the same shape of mistake that read balances off the
            // wallet handles instead of the state, so this one refuses to
            // guess: if the flag is missing entirely the answer is null - not
            // knowing is reported as not knowing, never as zero.
            const coins = u?.totalCoins ?? [];
            const flags = coins.map((c) => c?.meta?.registeredForDustGeneration);
            out.registered = coins.length === 0 ? 0
                : flags.every((f) => typeof f !== 'boolean') ? null
                    : flags.filter((f) => f === true).length;
        } catch (e) { out.nightError = String(e?.message ?? e).slice(0, 160); }
        try {
            const d = latest.dust;
            out.dustCoins = (d?.totalCoins ?? []).length;
            out.dustAvailable = (d?.availableCoins ?? []).length;
            out.dustPending = (d?.pendingCoins ?? []).length;
        } catch (e) { out.dustError = String(e?.message ?? e).slice(0, 160); }
        return out;
    }

    // Set by a node reject. A reject leaves dust atoms pending inside the
    // facade, and while `revert` should hand them back, persisting the state
    // is what turns a bad minute into a bad week: a snapshot taken after a
    // reject is restored on every future start, so a restart stops healing it.
    // The snapshots are only a warm-start optimisation - losing one costs a
    // slower boot, keeping a poisoned one costs the wallet.
    let rejected = false;

    async function snapshot(reason) {
        if (rejected && reason !== 'force') {
            log(`demo: skipping the ${reason} snapshot - a node reject happened this session,`,
                'and persisting that state would survive a restart');
            return;
        }
        try {
            saveBlob('shielded', await facade.shielded.serializeState());
            saveBlob('unshielded', await facade.unshielded.serializeState());
            saveBlob('dust', await facade.dust.serializeState());
            writeFileSync(join(stateDir, 'meta.json'), JSON.stringify({ savedAt: new Date().toISOString(), reason }, null, 2));
        } catch (e) { log('demo: snapshot failed:', e?.message ?? e); }
    }

    const warmup = (async () => {
        log('demo: starting wallet facade from snapshots...');
        facade = await WalletFacade.init({
            configuration,
            provingService: () => makeWasmProvingService(),
            shielded: () => restore.shielded ? ShieldedWallet(configuration).restore(restore.shielded)
                : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
            unshielded: () => restore.unshielded ? UnshieldedWallet(configuration).restore(restore.unshielded)
                : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
            dust: () => DustWallet(configuration).restore(restore.dust)
        });
        await facade.start(zswapKeys, dustKey);
        watchState();
        await gateToTip(30 * 60_000);
        ready = true;
        log(`demo: wallet at tip (dust applied=${dust.applied}); preprod runs enabled`);
        await snapshot('warmup');
    })().catch((e) => { warmError = e; log('demo: warmup FAILED:', e?.message ?? e); });

    // Never snapshot mid-run: a run between balancing and confirmation has
    // pending atoms by design, and freezing that is the same trap as freezing
    // a reject.
    const snapTimer = setInterval(() => { if (ready && queueLength === 0) snapshot('periodic'); }, 30 * 60_000);
    snapTimer.unref?.();

    // ---- daily cap ---------------------------------------------------------
    const counterPath = join(stateDir, 'demo-counter.json');
    const todayUtc = () => new Date().toISOString().slice(0, 10);
    function readCounter() {
        try {
            const c = JSON.parse(readFileSync(counterPath, 'utf8'));
            if (c.date === todayUtc()) return c;
        } catch { }
        return { date: todayUtc(), used: 0 };
    }
    function takeSlot() {
        const c = readCounter();
        if (c.used >= capacity) {
            throw Object.assign(new Error(`today's ${capacity} demo runs are used; the counter resets at 00:00 UTC`), { code: 'CAP' });
        }
        c.used += 1;
        writeFileSync(counterPath, JSON.stringify(c));
        return c;
    }

    // ---- indexer helpers ---------------------------------------------------
    async function latestContractAction() {
        const r = await fetch(INDEXER_HTTP, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `{ contractAction(address: "${contractAddress}") { __typename transaction { hash block { height } } } }` })
        }).then((x) => x.json()).catch(() => null);
        const a = r?.data?.contractAction;
        return a?.transaction?.hash
            ? { type: a.__typename, hash: a.transaction.hash, height: a.transaction.block?.height ?? 0 }
            : null;
    }

    /**
     * Find OUR transaction on chain, by identity rather than by coincidence.
     *
     * The confirm step used to accept any ContractCall newer than a baseline
     * taken before submitting. On a public contract address that is not a
     * confirmation: a third party calling the same contract satisfies it, and
     * so does a second transaction of our own if a transport failure ever led
     * us to send twice. It answers "something happened" when the question is
     * "did MY transaction land".
     *
     * `identifiers()` is the sanctioned way to watch for a specific
     * transaction - the ledger's own docs say `transactionHash()` must NOT be
     * used for this, because merging can change it - and the indexer's
     * transaction offset takes one. (ODATANO's finding 4.)
     */
    function txIdentifiers(finalized) {
        try {
            const ids = finalized?.identifiers?.() ?? [];
            return [...ids].map(String).filter((s) => /^[0-9a-f]+$/i.test(s));
        } catch { return []; }
    }

    /**
     * Landing in a block and being applied are different things.
     *
     * This asked only for the hash and the height, so a transaction that
     * reached a block with its call REJECTED came back indistinguishable from
     * one that wrote what it said - the fee is spent either way. The stage
     * would have been reported confirmed, the receipt would carry a hash, and
     * the page would tell a visitor the passport holds a value the ledger
     * never took.
     *
     * transactionResult.status is the ledger's own verdict, so ask for it and
     * treat anything other than SUCCESS as a failed stage. A partial success
     * names the segments that failed.
     */
    async function findByIdentifiers(ids) {
        for (const id of ids) {
            const r = await fetch(INDEXER_HTTP, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `{ transactions(offset: { identifier: "${id}" }) { hash block { height } ` +
                        `... on RegularTransaction { transactionResult { status segments { id success } } } } }`
                })
            }).then((x) => x.json()).catch(() => null);
            const t = r?.data?.transactions?.[0];
            if (!t?.hash) continue;
            const status = t.transactionResult?.status ?? null;
            // No status at all means the indexer has the transaction but not
            // yet its result. Keep waiting rather than guessing either way.
            if (status == null) continue;
            if (status !== 'SUCCESS') {
                const failed = (t.transactionResult?.segments ?? [])
                    .filter((s) => s && s.success === false).map((s) => s.id);
                throw Object.assign(new Error(
                    `the node accepted this transaction but the ledger did not apply it ` +
                    `(${status}${failed.length ? `, failed segment${failed.length > 1 ? 's' : ''} ${failed.join(', ')}` : ''}). ` +
                    'The fee is spent and nothing was written; the call has to be rebuilt against current state.'
                ), { notApplied: true, hash: t.hash, height: t.block?.height ?? 0 });
            }
            return { type: 'ContractCall', hash: t.hash, height: t.block?.height ?? 0 };
        }
        return null;
    }

    // ---- what the node's sub-code actually means ----------------------------
    //
    // A rejected submission comes back as a bare `1010 Invalid Transaction`
    // with a numeric sub-code, and those sub-codes are not interchangeable.
    // Verified against midnightntwrk/midnight-node, ledger/src/versions/
    // common/types.rs, via the midnight-status-codes reference:
    //
    //   170 InvalidDustSpendProof   the DUST FEE PROOF is invalid - typically
    //                               proven against a dust root the node has
    //                               moved past. Re-gate and rebuild. The
    //                               wallet is NOT out of dust.
    //   171 OutOfDustValidityWindow the transaction outlived its ttl. Rebuild.
    //   117 NotNormalized           malformed transaction, classically a zero
    //                               fee. Waiting does not fix it.
    //   138 BalanceCheckOverspend   dust-side: the fee exceeded available
    //                               dust. THIS is what out-of-dust looks like.
    //   173 InsufficientDustFor...  out of dust, registration specifically.
    //   219-224 SequencingCheck.*   the batch's call order is illegal;
    //                               splitting into single calls does fix it.
    //   188 SequencingCheckFailure  RETIRED - the current ledger never emits
    //                               it. Kept here only for older nodes.
    //
    // Getting this table wrong is not academic. 170 was previously classified
    // as a funding failure, so a run that hit a stale dust root aborted
    // claiming "out of dust" - against a wallet holding 1.06e19 SPECKs - and
    // sent us to a faucet for NIGHT we already had. The sub-code was saying
    // "your proof is stale", and we read it as "your wallet is empty".
    const OUT_OF_DUST = 'out of dust: the signing wallet cannot pay a fee right now';

    // The sub-code table lives in nightgate-tx, which owns it: it walks the
    // error's whole cause chain rather than a single message string, and it
    // covers the full set - including 196 (nullifier already known, a stale
    // dust proof by another name) and 117 (NotNormalized, which no amount of
    // waiting fixes). Our own extra patterns stay as an OR: they came from
    // messages this preprod node has actually produced.
    const kindOf = (msgOrErr) => classifyNodeReject(msgOrErr).kind;

    // The fee proof itself was refused. Re-gate to the tip and prove again.
    const isStaleDustProof = (msg) => kindOf(msg) === 'stale-dust-proof';

    // The wallet genuinely cannot pay. Only these say that.
    const isFundsProblem = (msg) =>
        kindOf(msg) === 'funds' || /InvalidTransaction::Payment/i.test(String(msg));

    // The batch's shape is the problem, so splitting it into single calls is
    // the remedy. Nothing else here is worth splitting for.
    const isSequencingProblem = (msg) =>
        kindOf(msg) === 'sequencing' || /segment ordering/i.test(String(msg));

    // Every wait on the node gets a bound. The websocket send already had one;
    // opening the API did not, and that is the wait that has actually hurt us:
    // when the node went away mid-run, ApiPromise.create sat there retrying
    // with nothing to report, and the stage deadline was the only thing that
    // ever ended it. A backstop should not be the first thing to notice that a
    // dependency is gone.
    const NODE_INIT_TIMEOUT_MS = 30_000;
    const NODE_PING_TIMEOUT_MS = 8_000;
    const SUBMIT_TIMEOUT_MS = 30_000;

    // How long to keep asking the indexer whether a submit we did not get a
    // clean answer for landed anyway. Long enough to outlast indexer lag on a
    // transaction that IS in the pool; short enough to stay well inside the
    // stage budget, which is the real backstop.
    const LANDING_PROBE_MS = 90_000;

    const withTimeout = (promise, ms, what) => {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(what), { transport: true })), ms); })
        ]).finally(() => clearTimeout(timer));
    };

    /**
     * Is the node answering at all? Asked before a stage spends ~35s of proving
     * on a transaction it will not be able to submit. The wallet's dust balance
     * is already checked up front for the same reason; the node deserves the
     * same courtesy.
     *
     * A true answer is not a promise the node will still be there at submit
     * time - only bounding the submit itself covers that - so this is a fast
     * honest failure, not a guarantee.
     */
    async function nodeReachable() {
        try {
            const r = await fetch(NODE_HTTP, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_chain', params: [] }),
                signal: AbortSignal.timeout(NODE_PING_TIMEOUT_MS)
            });
            if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
            const j = await r.json();
            return j?.result ? { ok: true, chain: String(j.result) } : { ok: false, why: 'no result' };
        } catch (e) {
            return { ok: false, why: String(e?.message ?? e) };
        }
    }

    // ---- submission (the path that works: encode HTTP, submit one-shot ws) -
    //
    // Two halves, and each is bounded by whoever can bound it.
    //
    // The ENCODE stays here because opening the API is a wait that needs a
    // deadline: a node that stops answering must surface as a fast, named
    // failure rather than as a stage that stops making progress.
    // nightgate-tx's own submitFinalized leaves that open unbounded, so we
    // keep this half and hand it the encoded extrinsic.
    //
    // The SEND is nightgate-tx's submitExtrinsic: it treats a socket that
    // closes before replying as an immediate transport failure rather than
    // something to wait out, settles exactly once, ignores frames it cannot
    // parse, and puts the reject code and the ledger sub-code on the error
    // object instead of only in its message.

    /** The extrinsic bytes, encoded against the node's live runtime metadata. */
    async function encodeExtrinsic(finalized) {
        const { ApiPromise, HttpProvider } = await import('@polkadot/api');
        const api = await withTimeout(
            ApiPromise.create({ provider: new HttpProvider(NODE_HTTP), noInitWarn: true }),
            NODE_INIT_TIMEOUT_MS,
            `node API did not open within ${NODE_INIT_TIMEOUT_MS / 1000}s`);
        try {
            const bytes = Buffer.from(finalized.serialize());
            return api.tx.midnight.sendMnTransaction('0x' + bytes.toString('hex')).toHex();
        } finally { try { await api.disconnect(); } catch { } }
    }

    async function submitFinalized(finalized) {
        const extrinsicHex = await encodeExtrinsic(finalized);
        return submitExtrinsic(extrinsicHex, { nodeUrl: NODE_WS, timeoutMs: SUBMIT_TIMEOUT_MS });
    }

    // ---- one run -----------------------------------------------------------
    async function executeRun(job, intake, signal) {
        // Checked wherever the run is about to start something expensive or
        // chain-touching. A wasm proof cannot be interrupted once it is
        // running, so the guarantee is "starts nothing new after the abort",
        // not "stops instantly" - which is why the queue also waits out a
        // grace period before releasing.
        const halt = () => {
            if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
        };
        // Sleep that gives up early when the run is cancelled, so a poll loop
        // does not keep the whole run alive for another full interval.
        const nap = (ms) => new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason ?? new Error('run cancelled'));
            const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
            const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('run cancelled')); };
            signal?.addEventListener('abort', onAbort, { once: true });
        });

        // Steps are keyed by id so a retried stage reuses its rows instead of
        // duplicating them in the job view.
        const step = (id, label) => {
            let s = job.steps.find((x) => x.id === id);
            if (!s) { s = { id, label, status: 'pending', detail: '', startedAt: null, ms: null }; job.steps.push(s); }
            else { s.status = 'pending'; s.detail = ''; s.label = label; s.startedAt = null; s.ms = null; }
            return s;
        };
        // Timing is recorded here rather than in the page, so a reload picks up
        // the real elapsed time instead of restarting the clock, and a step
        // that finished while the tab was closed still reports what it took.
        const runStep = async (s, fn) => {
            s.status = 'running'; s.startedAt = new Date().toISOString(); s.ms = null; job.touch();
            const settle = (status, detail) => {
                s.status = status;
                s.ms = Date.now() - Date.parse(s.startedAt);
                if (detail != null) s.detail = detail;
                job.touch();
            };
            try { const v = await fn(); settle('done'); return v; }
            catch (e) { settle('failed', String(e?.message ?? e)); throw e; }
        };

        const runSeed = randomBytes(32);
        const saltFn = (label) => b2b(Uint8Array.from([...runSeed, ...utf8(label)]));
        const vin = intake.vin;
        const vinBytes = vinHashOf(vin);
        const regId = registrarId(intake.registrar);
        const croot = contentRoot(vin, intake.fields ?? {}, intake.panel ?? {}, saltFn);

        // Every write's value+salt, per field, in order; claims open the last.
        const writes = {};
        const saltOf = (name, seq) => saltFn(`:salt:${name}:${seq}`);

        const plan = { vin, stages: planCalls(intake) };

        // -- pre-simulate through the real compiled circuits: refusals are
        //    results and are never submitted; a refused write also refuses
        //    everything that would have opened its commitment.
        const simStep = step('simulate', 'Dry-run through the compiled circuits');
        const refused = [];
        await runStep(simStep, async () => {
            const sim = new PassportSimulator();
            for (const stage of plan.stages) {
                stage.steps = stage.steps.filter((s) => {
                    try {
                        if (s.kind === 'register') sim.registerPassport(vinBytes, croot, regId);
                        else if (s.kind === 'init') {
                            if (!(s.name in FIELDS)) throw new Error('unknown field');
                            const salt = saltOf(s.name, 0);
                            sim.initialiseField(vinBytes, K[s.name], FIELDS[s.name].rule, s.value, salt);
                            writes[s.name] = [{ value: s.value, salt }];
                            s.writeIndex = 0;
                        } else if (s.kind === 'update') {
                            if (!(s.name in FIELDS)) throw new Error('unknown field');
                            const salt = saltOf(s.name, (writes[s.name]?.length ?? 0));
                            sim.recordField(vinBytes, K[s.name], s.value, salt);
                            s.writeIndex = ((writes[s.name] ??= []).push({ value: s.value, salt })) - 1;
                        } else if (s.kind === 'claim') {
                            sim.proveFieldAtMost(vinBytes, K[s.name], s.bound);
                            // Claims run last, so the write they open is the
                            // field's final one - fixed here, not at call time.
                            s.writeIndex = (writes[s.name]?.length ?? 0) - 1;
                        }
                        return true;
                    } catch (e) {
                        refused.push({ step: stepLabel(s), reason: String(e?.message ?? e).replace(/^.*failed assert: /, '') });
                        return false;
                    }
                });
            }
            // Relabel from what SURVIVED. A stage keeps the label it was
            // planned with otherwise, and would go on naming a claim the
            // dry-run refused and never submitted.
            plan.stages = plan.stages.filter((st) => st.steps.length > 0).map((st) => makeStage(st.steps));
            simStep.detail = refused.length ? `${refused.length} step(s) refused in-circuit; not submitted` : 'every step provable';
            if (!plan.stages.length) throw new Error('nothing survived the dry-run');
        });

        // -- shared witnesses: per-call state swapped in by `before` hooks,
        //    and refused entirely until one has armed them (preprod-plan.mjs
        //    carries the why - an unarmed read would commit a zero value).
        const { holder, witnesses, arm } = makeWitnessHolder();
        // Pure: every call is derived from the step's own writeIndex, fixed
        // during the dry-run. A stage that has to be re-planned (a rejected
        // batch split into single calls) therefore rebuilds identical calls.
        const writeAt = (name, i) => writes[name]?.[i] ?? { value: 0n, salt: zero32() };
        const toCall = (s) => {
            const label = stepLabel(s);
            if (s.kind === 'register') {
                // Reads no witness, but still arms: a batch behind it must not
                // inherit an arming that belongs to some earlier call.
                return {
                    circuitId: 'registerPassport', args: [vinBytes, croot, regId],
                    before: arm(label, { pending: { value: 0n, salt: zero32() }, prev: { value: 0n, salt: zero32() } })
                };
            }
            if (s.kind === 'init') {
                const w = writeAt(s.name, 0);
                return {
                    circuitId: 'initialiseField', args: [vinBytes, K[s.name], FIELDS[s.name].rule],
                    before: arm(label, { pending: { ...w }, prev: { value: 0n, salt: zero32() } })
                };
            }
            if (s.kind === 'update') {
                const prev = writeAt(s.name, s.writeIndex - 1);
                const w = writeAt(s.name, s.writeIndex);
                return {
                    circuitId: 'recordField', args: [vinBytes, K[s.name]],
                    before: arm(label, { pending: { ...w }, prev: { ...prev } })
                };
            }
            const opened = writeAt(s.name, s.writeIndex);
            return {
                circuitId: 'proveFieldAtMost', args: [vinBytes, K[s.name], s.bound],
                before: arm(label, { pending: { value: 0n, salt: zero32() }, prev: { ...opened } })
            };
        };

        // -- wait for the wallet, then run stage by stage
        const walletStep = step('wallet', 'Wallet at chain tip, node reachable, dust ready');
        await runStep(walletStep, async () => {
            await warmup;
            if (warmError) throw warmError;
            // Ask the node whether it is there before proving anything for it.
            // Same argument as the dust floor below: a run that discovers at
            // stage four that it cannot submit has already spent three fees and
            // several minutes of someone's attention, and left a passport
            // half-written on a public chain.
            const node = await nodeReachable();
            if (!node.ok) {
                throw new Error(`the preprod node is not answering (${node.why}). ` +
                    'This is the public network being unavailable, not a fault in the run; try again shortly.');
            }
            // Bounded by the same warm-up budget the run publishes, so the
            // advertised budget is the truth rather than an underestimate.
            await gateToTip(WARMUP_BUDGET_MS);
            // Say what the wallet can pay with BEFORE proving anything. A run
            // that dies of dust at stage five has already spent four fees, a
            // slot from the daily cap and several minutes of the visitor's
            // attention, and left a passport half-written on a public chain.
            const bal = dustBalance();
            walletStep.detail = (bal == null ? 'dust balance unavailable'
                : `dust balance ${bal}${MIN_DUST ? ` · floor ${MIN_DUST}` : ''}`)
                + ` · node ${node.chain ?? 'ok'}`;
            if (bal != null && MIN_DUST && bal < MIN_DUST) {
                throw Object.assign(new Error(
                    `${OUT_OF_DUST} (balance ${bal}, needs about ${MIN_DUST} for a full run). ` +
                    'Dust regenerates from NIGHT registered for dust generation; this is a wallet top-up, not a bug in the run.'
                ), { funds: true });
            }
        });

        const stagesOut = [];
        const queue = [...plan.stages];
        let n = 0;
        // Now the plan is known, so the run's budget can be a number derived
        // from it rather than a flat guess. Publishing it lets the page say
        // how long a run may legitimately take instead of leaving a slow run
        // looking indistinguishable from a stuck one.
        job.budgetMs = WARMUP_BUDGET_MS + queue.length * STAGE_BUDGET_MS;
        job.stagesPlanned = queue.length;
        job.touch();
        while (queue.length) {
            const stage = queue.shift();
            n += 1;
            const calls = stage.steps.map(toCall);
            // Each stage is bounded on its own. A stage that hangs now fails
            // in minutes with a message naming the stage, instead of quietly
            // eating the whole run's budget and surfacing as a bare timeout.
            halt();                       // do not begin a stage after a cancel
            const stageEndsAt = Date.now() + STAGE_BUDGET_MS;
            const overBudget = `stage ${n} (${stage.label}) exceeded its ` +
                `${Math.round(STAGE_BUDGET_MS / 60_000)} minute budget`;
            // Checked before starting another attempt, which costs a proof.
            const stageBudget = () => { if (Date.now() > stageEndsAt) throw new Error(overBudget); };
            // The budget is also armed as a real deadline, so it holds for a
            // stage whose first attempt has not returned yet: the check above
            // is only reached between attempts, and a stage need not make it
            // that far to be over its time.
            //
            // It goes through the run's own controller rather than racing the
            // await, so an overrunning stage takes exactly the same path as
            // the outer backstop. One place decides when a run is reported and
            // when the queue moves on, and both know a rejected promise is not
            // a finished run.
            clearTimeout(job.stageTimer);
            job.stageTimer = setTimeout(() => job.abort?.(overBudget), STAGE_BUDGET_MS);
            job.stageTimer.unref?.();

            // A 1010 reject is a known batch outcome; the remedy is to REBUILD
            // with fresh randomness, never to resubmit the same bytes. If a
            // multi-call transaction keeps being refused, the batch itself is
            // the problem: split it into single calls (the shape proven to
            // land) and carry on rather than losing the run.
            let submitted = null;
            let attempt = 0;
            let split = false;
            // Carries a proven call forward to the next attempt. Set only for a
            // refused FEE, cleared as soon as it is used: if re-balancing the
            // same proof is refused too, the proof stops being the cheap answer
            // and the next attempt proves the call again.
            let reuse = null;
            for (; ;) {
                attempt += 1;
                try {
                    submitted = await runStageOnce(n, stage, calls, attempt, reuse);
                    break;
                } catch (e) {
                    const spent = reuse;
                    reuse = null;
                    const msg = String(e?.message ?? e);
                    // A funding failure is not a batching failure. Splitting a
                    // batch we cannot pay for just buys two more proofs we
                    // also cannot pay for.
                    if (isFundsProblem(msg)) throw Object.assign(new Error(OUT_OF_DUST), { funds: true });
                    const sequencing = isSequencingProblem(msg);
                    const dustProof = isStaleDustProof(msg);
                    // A 1010 whose sub-code this table does not recognise
                    // still earns ONE rebuild with fresh randomness - cheap
                    // insurance against a code added upstream since - but it
                    // never earns a split, because splitting only ever
                    // remedies call ordering.
                    const unknown1010 = !sequencing && !dustProof && /\b1010\b/.test(msg);
                    if (!sequencing && !dustProof && !unknown1010) throw e;
                    // Splitting only ever helps a SEQUENCING refusal, because
                    // there the batch's call order is the thing being
                    // rejected. A refused dust proof is about the fee, which
                    // is identical in a single call - splitting it just buys
                    // more proofs against the same stale root, which is what
                    // this code used to do on every bare 1010.
                    if (sequencing && stage.steps.length > 1 && attempt >= 2) {
                        log(`demo: batch of ${stage.steps.length} refused twice (${msg}); splitting into single calls`);
                        queue.unshift(...stage.steps.map((s) => makeStage([s])));
                        for (const id of [`build:${n}`, `fund:${n}`, `submit:${n}`]) {
                            const row = job.steps.find((x) => x.id === id);
                            if (row?.status === 'failed') row.detail = 'batch refused by the node; retrying these calls one transaction at a time';
                        }
                        split = true;
                        break;
                    }
                    if (attempt < (unknown1010 ? 2 : 3)) {
                        // Another attempt costs ~40s of proving, so only start
                        // one the stage still has room to finish.
                        halt();
                        stageBudget();
                        // A refused dust proof says the FEE was proven against
                        // a root the node has moved past; it says nothing about
                        // the contract call, which is why the call's proof can
                        // be carried over and only the fee rebuilt. Offered
                        // once: if the attempt that reused it is refused too,
                        // `spent` is set and the next attempt proves again.
                        reuse = dustProof && !spent && e.reuse ? e.reuse : null;
                        log(`demo: stage ${n} rejected by the node (attempt ${attempt}: ${msg});`,
                            reuse ? 'rebuilding the fee only' : 'rebuilding');
                        continue;
                    }
                    throw e;
                }
            }
            // The failed batch keeps its step rows and its explanation; the
            // split calls get fresh numbers behind it.
            if (split) continue;
            const baseline = submitted.baseline;

            const landed = await runStep(step(`confirm:${n}`, 'Wait for the block and the indexer'), async () => {
                const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
                // Ask first, then wait. Sleeping before the first look spent
                // ten seconds per stage discovering nothing, and blocks are
                // about six seconds apart, so a ten-second poll added its own
                // latency on top of the chain's.
                const ids = submitted.ids ?? [];
                // Say which path is confirming. Without this the fallback is
                // silent, and "it confirmed" would not tell us whether it
                // confirmed OUR transaction or merely a new one.
                log(`demo: stage ${n} confirming by ${ids.length ? `identifier (${ids.length})` : 'BASELINE fallback - no identifiers'}`);
                for (; ;) {
                    // By identity when we have one. The baseline comparison
                    // stays only as a fallback for the case where the ledger
                    // gives us no identifiers, because it cannot tell our
                    // transaction from anyone else's.
                    if (ids.length) {
                        const mine = await findByIdentifiers(ids);
                        if (mine) return mine;
                    } else {
                        const a = await latestContractAction();
                        if (a && a.type === 'ContractCall' && (!baseline || a.hash !== baseline.hash || a.height > baseline.height)) return a;
                    }
                    if (Date.now() >= deadline) break;
                    await nap(CONFIRM_POLL_MS);
                }
                throw new Error(`not visible on the indexer within ${Math.round(CONFIRM_TIMEOUT_MS / 60_000)} minutes ` +
                    '(it may still land; check the contract address)');
            });

            stagesOut.push({
                stage: n, label: stage.label, calls: stage.steps.map(stepLabel),
                extrinsicHash: submitted.extrinsicHash, txHash: landed.hash, blockHeight: landed.height
            });
            const st = job.steps.find((s) => s.id === `confirm:${n}`);
            st.detail = `tx ${landed.hash} in block ${landed.height}`;
            job.touch();
        }
        // The deadline belongs to the stages, so it is released with them. The
        // run's tail - the result, the snapshot - is the outer backstop's to
        // bound, never the last stage's clock.
        clearTimeout(job.stageTimer);

        /**
         * One attempt at a stage: prove, pay, submit.
         *
         * `reuse` carries the transaction a previous attempt already proved.
         * A stale dust proof is a complaint about the FEE, not about the
         * contract call, so re-proving the call costs ~30-100s of wasm to
         * arrive at the identical proof. Re-balancing the same built
         * transaction produces fresh bytes - a new dust proof and a new
         * binding - which is what a reject requires; only a transport failure
         * ever licenses sending identical bytes.
         *
         * The contract proof is only reusable while the contract's state has
         * not moved under it: the call carries a transcript that has to replay
         * against current state, and a call that lands and fails costs its fee
         * exactly like one that succeeds. So the reuse is conditional on the
         * contract's latest action being the one it was proven against, and
         * anything else falls back to a full rebuild.
         */
        async function runStageOnce(n, stage, calls, attempt, reuse = null) {
            const suffix = attempt > 1 ? ` (attempt ${attempt})` : '';
            // Proving is ~40s of CPU. Spending it on a transaction we already
            // know we cannot fund is the expensive way to reach the same
            // failure, so ask the wallet first.
            const before = dustBalance();
            if (before === 0n) throw Object.assign(new Error(OUT_OF_DUST), { funds: true });
            // stage.label already reads "prove noAccidents" for a single call,
            // so prefixing "Prove " again gave "Prove prove noAccidents".
            const what = /^prove /i.test(stage.label) ? stage.label : `Prove ${stage.label}`;

            // Is the proof we already hold still good? Only if nothing has
            // touched the contract since it was made. One indexer query
            // decides whether the next 30-100s of proving is necessary work or
            // an identical result computed twice.
            let keep = null;
            if (reuse) {
                const now = await latestContractAction();
                const why = proofReusable(reuse.action, now);
                if (why !== null) {
                    log(`demo: stage ${n} cannot reuse its proof (${why}); rebuilding`);
                } else {
                    keep = reuse.built;
                    const row = job.steps.find((x) => x.id === `build:${n}`);
                    if (row) {
                        row.status = 'done';
                        row.detail = 'proof reused - the node refused the fee, not the call';
                        job.touch();
                    }
                    log(`demo: stage ${n} reusing the proven call; only the fee is rebuilt`);
                }
            }

            halt();                       // a proof is ~40s we cannot take back
            const builtAtAction = keep ? reuse.action : await latestContractAction();
            const built = keep ?? await runStep(step(`build:${n}`, `${what} (${calls.length} call${calls.length === 1 ? '' : 's'}, in-process)${suffix}`), async () => {
                // Every call in this contract moves no value: they write
                // commitments, and OUR facade does the dust balancing further
                // down. So the builder's own wallet sync is pure cost - it
                // syncs from genesis on this thread for the life of the
                // builder, and we build one of these per stage.
                //
                // On 0.4.0 that cost did not even end with the stage: close()
                // called `facade.close?.()`, the facade only has stop(), and
                // optional chaining made it a silent no-op - so each stage
                // left a facade syncing and an indexer socket open until the
                // process exited. It showed in the run: stages 2 and 3 do
                // identical work, one initialiseField each, and stage 3 took
                // 13s longer, with every later stage slower again.
                // 0.4.1 fixed close(); walletSync skips the sync entirely.
                const builder = await createTxBuilder({
                    seedHex, networkId: NETWORK_ID,
                    indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS, nodeUrl: NODE_WS,
                    provingMode: 'wasm', zkConfigDir: ZK_CONFIG_DIR,
                    contractClass: Contract, contractName: 'vinpassport',
                    privateStateId: 'vinpassport-demo',
                    walletSync: false,
                    // A proof that never returns would otherwise sit inside the
                    // stage budget with nothing to report; bound it just under
                    // the budget so the stage fails saying "proving", not
                    // "stage exceeded".
                    proofTimeoutMs: Math.round(STAGE_BUDGET_MS * 0.6),
                    circuits: [...new Set(calls.map((c) => c.circuitId))]
                });
                try {
                    // Arm the first call ourselves: the builder runs `before`
                    // hooks per call for a BATCH, but a single call is proven
                    // with the witnesses exactly as they stand. Doing it here
                    // makes both paths identical, and a batch simply re-arms
                    // in call order as it proves.
                    holder.armed = null;
                    calls[0].before();
                    return await builder.buildSponsorable({
                        contractAddress, calls, witnesses, initialPrivateState: {}, bind: true,
                        // A claims batch is genuinely independent: two
                        // proveFieldAtMost calls on DIFFERENT fields read the
                        // ledger and write nothing, so no order between them
                        // is required. Told that, the builder groups them by
                        // stage instead of insisting array order satisfies
                        // causality, and fails fast before proving if it
                        // cannot. Every other batch here IS ordered -
                        // registerPassport has to precede the initialiseField
                        // that follows it - so this stays off by default.
                        independentCalls: stage.steps.every((s) => s.kind === 'claim')
                    });
                } finally { await builder.close?.(); }
            });

            const fundStep = step(`fund:${n}`, 'Pay the fee in dust (our wallet)');
            const finalized = await runStep(fundStep, async () => {
                const bytes = Uint8Array.from(Buffer.from(built.finalizedTxB64, 'base64'));
                let tx = null;
                for (const tags of [['signature', 'proof', 'binding'], ['signature', 'proof', 'pre-binding']]) {
                    try { tx = Transaction.deserialize(...tags, bytes); if (tx) break; } catch { }
                }
                if (!tx) throw new Error('could not deserialize the built transaction');
                const attempt = async () => {
                    halt();               // never balance dust for a cancelled run
                    // Every stage spends a dust UTXO; the wallet must have seen
                    // the previous stage's spend before it picks the next one,
                    // and "seen" has to mean level, not within a hundred.
                    await gateToApplied(GATE_TIMEOUT_MS, signal);
                    const recipe = await facade.balanceFinalizedTransaction(
                        tx, { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
                        { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
                    );
                    return facade.finalizeRecipe(recipe);
                };
                try { return await attempt(); }
                catch (e) {
                    const msg = String(e?.message ?? e);
                    // Retrying a balance we cannot afford just waits to fail
                    // the same way.
                    if (isFundsProblem(msg)) throw Object.assign(new Error(`${OUT_OF_DUST} (${msg})`), { funds: true });
                    // 170 InvalidDustSpendProof and 171 OutOfDustValidityWindow
                    // both mean the fee proof itself was refused, so re-gate to
                    // the tip and prove it again rather than giving up.
                    if (!isStaleDustProof(msg) && !/1010|invalid|stale/i.test(msg)) throw e;
                    await gateToApplied(GATE_TIMEOUT_MS, signal);
                    return attempt();
                }
            });
            // Record what the fee actually cost, so the floor above can be set
            // from observation instead of guesswork.
            const after = dustBalance();
            if (before != null && after != null) {
                fundStep.detail = `dust ${before} -> ${after} (fee ${before - after})`;
                job.touch();
            }

            const baseline = await latestContractAction();
            const ids = txIdentifiers(finalized);
            halt();                       // never submit for a cancelled run
            const extrinsicHash = await runStep(step(`submit:${n}`, 'Submit to the preprod node'), async () => {
                try {
                    return await submitFinalized(finalized);
                } catch (e) {
                    // Set before anything else, including the probe below: from
                    // here on the wallet's state is something we cannot vouch
                    // for, so no snapshot gets persisted for this run - not
                    // even if the probe turns up a transaction that landed
                    // cleanly. A skipped snapshot costs a re-sync on the next
                    // restart; a persisted wrong one costs the wallet.
                    rejected = true;

                    // A TRANSPORT failure is not a rejection. The websocket
                    // closing or timing out says nothing about whether the
                    // node took the transaction, so treating it as a failure
                    // can fail a run whose transaction is landing as we speak
                    // - and reverting the dust for a spend that DID happen
                    // would be worse than the leak it fixes. Ask the chain
                    // before deciding.
                    //
                    // 1013 Already Imported is the same situation read from
                    // the other side: it is the node telling us the
                    // transaction IS in the pool, which makes it evidence of
                    // success, not a failure to report.
                    if (!isPreMempoolReject(e) && ids.length) {
                        if (isAlreadyImported(e)) log(`demo: stage ${n} was already in the pool; waiting for it to land`);
                        else if (isTransportFailure(e)) log(`demo: stage ${n} lost the submit socket; asking the chain whether it landed`);
                        const until = Date.now() + LANDING_PROBE_MS;
                        for (let first = true; first || Date.now() < until; first = false) {
                            await nap(first ? 12_000 : 6_000);
                            const landed = await findByIdentifiers(ids);
                            if (landed) {
                                log(`demo: stage ${n} submit reported "${e?.message ?? e}" but the tx is on chain (${landed.hash})`);
                                return landed.hash;
                            }
                        }
                    }
                    // Give the dust back before rethrowing - but ONLY for a
                    // reject that provably never reached the mempool (1010 /
                    // 1014 / 1016). That is the whole condition: on a
                    // transport failure the transaction may be in the pool
                    // right now, and reverting a spend that really happens
                    // desynchronises the wallet from the chain in the
                    // direction that costs money rather than the one that
                    // merely wastes dust.
                    //
                    // Balancing marks the spent dust note pending inside the
                    // facade. A node reject happens BEFORE the mempool, so
                    // that note is never actually spent - but nothing tells
                    // the wallet, and the atoms stay pending. Rebuild after
                    // rebuild they accumulate until balancing fails on a
                    // wallet with plenty of dust, which is precisely the
                    // "Insufficient Funds: could not balance dust" we hit on
                    // a wallet holding 1.06e19 SPECKs, and which the classifier
                    // then had to call out-of-dust because it looked like it.
                    //
                    // Missing this is what made a recoverable stall look like
                    // an empty wallet. (ODATANO's finding 2.)
                    if (isPreMempoolReject(e)) {
                        const { kind, subCode } = classifyNodeReject(e);
                        try {
                            await facade.revert(finalized);
                            log(`demo: stage ${n} rejected before the mempool (${kind}${subCode == null ? '' : ` ${subCode}`});`,
                                'reverted the dust spend');
                        } catch (re) {
                            // Worth saying out loud: from here the pending atoms
                            // are stranded until the process restarts.
                            log(`demo: stage ${n} rejected AND the dust revert failed (${re?.message ?? re});`,
                                'pending dust may be stranded until restart');
                        }
                    } else {
                        // The honest position: we do not know whether this
                        // spend happened, so we leave the wallet believing it
                        // did. The atoms stay pending until a restart, which
                        // is the cheap mistake to make in this direction.
                        log(`demo: stage ${n} submit failed without a pre-mempool reject (${e?.message ?? e});`,
                            'leaving the dust spend in place - it may be on chain');
                    }
                    // Hand the proven call up with the failure. Whether it can
                    // be reused is the retry loop's decision, not this one's.
                    try { e.reuse = { built, action: builtAtAction }; } catch { /* frozen error */ }
                    throw e;
                }
            });
            return { extrinsicHash, baseline, ids };
        }

        // Only worth persisting a run that ended clean.
        if (!rejected) snapshot('post-run');

        // -- the receipt: the private half of the passport, for its holder
        job.receipt = {
            title: 'VINPassport preprod demo receipt',
            note: 'This file is the passport: the values and salts below never touched the chain. The chain holds only commitments; anyone can check the transactions listed here, and only the holder of this file can open them.',
            network: NETWORK_ID, contractAddress,
            kind: job.kind, finishedAt: new Date().toISOString(),
            vin, vinHash: hex(vinBytes),
            registrar: { name: intake.registrar, id: hex(regId) },
            contentRoot: hex(croot),
            runSeed: Buffer.from(runSeed).toString('hex'),
            saltRule: 'fieldSalt = blake2b256(runSeed || ":salt:<field>:<writeIndex>"), leafSalt = blake2b256(runSeed || ":leafsalt:v0:<vin>:<slot>")',
            fields: Object.fromEntries(Object.entries(writes).map(([name, ws]) => [name, ws.map((w, i) => ({ writeIndex: i, value: w.value.toString(), salt: hex(w.salt) }))])),
            panel: intake.panel ?? {},
            claims: (intake.prove ? Object.entries(CLAIM_DEFS) : []).flatMap(([claim, def]) => {
                const wanted = claim === 'mileageUnder' ? intake.prove?.mileageUnder : intake.prove?.[claim];
                if (!wanted) return [];
                const wasRefused = refused.some((r) => r.step.startsWith(`prove ${claim}`));
                return [{ claim, label: def.label + (claim === 'mileageUnder' ? ` ${wanted} km` : ''), outcome: wasRefused ? 'refused in-circuit - nothing written' : 'proven on-chain' }];
            }),
            refused,
            onChain: stagesOut,
            verify: {
                how: 'Ask the public indexer for this contract - the transactions above are its latest calls.',
                curl: `curl -s ${INDEXER_HTTP} -H 'Content-Type: application/json' -d '{"query":"{ contractAction(address: \\"${contractAddress}\\") { __typename transaction { hash block { height } } } }"}'`
            }
        };
        job.status = refused.length ? 'done-with-refusals' : 'done';
        job.touch();
    }

    // ---------------------------------------------------------------- queue

    const jobs = new Map();
    let queueTail = Promise.resolve();
    let queueLength = 0;

    // How long a cancelled run gets to notice and unwind. A proof in wasm is
    // not interruptible, so the honest number is "one proof plus slack".
    const ABORT_GRACE_MS = 3 * 60_000;

    // Set when a cancelled run would NOT stop. There is exactly one wallet
    // facade here, so a run still holding it is not something to run beside -
    // it is a reason to stop accepting runs and say so. Refusing the demo is
    // recoverable by a restart; two runs sharing a facade corrupts both and
    // spends real dust doing it.
    let wedged = null;

    /**
     * Wait for an aborted run to actually finish, not merely to have rejected.
     *
     * Releasing the queue on the rejection is the bug this exists to close:
     * the promise settles the moment the backstop fires, while the run itself
     * carries on proving and submitting.
     */
    async function settle(p, graceMs, job) {
        let done = false;
        p.then(() => { done = true; }, () => { done = true; });
        const end = Date.now() + graceMs;
        while (!done && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
        if (!done) {
            wedged = `run ${job.id} was cancelled but did not stop within ` +
                `${Math.round(graceMs / 60_000)} minutes; it may still be holding the wallet. ` +
                'Preprod runs are disabled until this process restarts.';
            log('demo: ' + wedged);
        }
    }

    function makeJob(kind) {
        const job = {
            id: randomUUID(), kind, status: 'queued', steps: [], receipt: null,
            createdAt: new Date().toISOString(), updatedAt: null, error: null,
            // The page shows a clock; the server owns it, so a reload or a
            // second viewer sees the same elapsed time rather than its own.
            startedAt: null, finishedAt: null, ms: null,
            budgetMs: null, stagesPlanned: null,
            touch() { this.updatedAt = new Date().toISOString(); },
            // The API serialises a job straight to the caller, so what a job
            // carries and what it publishes have to be separate things. They
            // were not: the run also hangs a controller and a stage timer off
            // this object, and a Node timer holds a reference back to itself,
            // which is not representable as JSON. Serialising the whole job
            // therefore threw inside the response - taking the process with
            // it, mid-run, on the first poll after a stage began.
            //
            // An explicit list is the point: a field is published because it
            // is named here, so anything the run needs to keep on a job from
            // now on stays internal by default.
            toJSON() {
                return {
                    id: this.id, kind: this.kind, status: this.status,
                    steps: this.steps, receipt: this.receipt,
                    createdAt: this.createdAt, updatedAt: this.updatedAt,
                    startedAt: this.startedAt, finishedAt: this.finishedAt,
                    ms: this.ms, budgetMs: this.budgetMs,
                    stagesPlanned: this.stagesPlanned, error: this.error
                };
            }
        };
        jobs.set(job.id, job);
        if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
        return job;
    }

    function enqueue(kind, intake) {
        if (warmError) throw new Error('the preprod wallet failed to start: ' + warmError.message);
        // A run that would not stop is still holding the one facade. Refuse
        // rather than start a second one beside it.
        if (wedged) throw Object.assign(new Error(wedged), { code: 'WEDGED' });
        takeSlot();                       // counts against today even if it later fails
        const job = makeJob(kind);
        queueLength += 1;
        // The backstop has to STOP the run, not just report it.
        //
        // This was `Promise.race([executeRun, timeout])`, which marks the job
        // failed and lets the queue move on while executeRun carries on
        // proving and submitting. The next visitor's run then shares this
        // facade with the abandoned one: their dust spends collide, and both
        // confirm loops watch the same contract address and can adopt each
        // other's transactions. So the one case the backstop exists for was
        // the one case that produced the concurrency the queue exists to
        // prevent. (Found by ODATANO's review; the 20 -> 75 minute ceiling
        // earlier the same day had made the window 55 minutes longer.)
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(
            new Error(`run exceeded the ${Math.round(JOB_CEILING_MS / 60_000)} minute backstop`)
        ), JOB_CEILING_MS);
        job.abort = (why) => ctl.abort(new Error(why ?? 'run cancelled'));

        queueTail = queueTail
            .then(async () => {
                job.status = 'running'; job.startedAt = new Date().toISOString(); job.touch();
                const running = executeRun(job, intake, ctl.signal);
                // Two separate jobs, and conflating them is how the original
                // bug happened. REPORTING must be prompt: race the abort, so
                // a run that ignores its signal is still reported as having
                // exceeded the backstop instead of quietly succeeding
                // whenever it eventually finishes. RELEASING the queue must
                // wait: a rejected promise is not a stopped run.
                const aborted = new Promise((_, rej) => ctl.signal.addEventListener(
                    'abort', () => rej(ctl.signal.reason ?? new Error('run cancelled')), { once: true }));
                try {
                    await Promise.race([running, aborted]);
                } catch (e) {
                    throw ctl.signal.aborted ? (ctl.signal.reason ?? e) : e;
                } finally {
                    await settle(running, ABORT_GRACE_MS, job);
                }
            })
            .catch((e) => {
                if (job.status !== 'done' && job.status !== 'done-with-refusals') {
                    job.status = 'failed'; job.error = String(e?.message ?? e); job.touch();
                    log('demo: run failed:', job.error);
                }
            })
            .finally(() => {
                clearTimeout(timer);
                clearTimeout(job.stageTimer);   // armed per stage; always cleared here
                queueLength -= 1;
                job.finishedAt = new Date().toISOString();
                if (job.startedAt) job.ms = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
                job.touch();
            });
        return job;
    }

    // ---------------------------------------------------------------- api

    function guidedIntake() {
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const base = 18_000 + Math.floor(Math.random() * 40_000);
        return {
            vin: randomDemoVin(),
            registrar: 'passport.vin-demo',
            fields: { odometerKm: base, accidentCount: 0, ownerCount: 2 },
            panel: {
                vehicleCategory: 'M1', fuelType: pick(['bev', 'petrol', 'hybrid']),
                firstRegistrationDate: 19_700 + Math.floor(Math.random() * 1_000),
                co2FootprintKgCO2e: 7_000 + Math.floor(Math.random() * 4_000),
                recycledPlasticPct: 20 + Math.floor(Math.random() * 15)
            },
            updates: [{ odometerKm: base + 12_000 + Math.floor(Math.random() * 20_000) }],
            // oneKeeper is DESIGNED to refuse (two keepers): the guided run
            // shows a refusal being caught in-circuit and reported, not hidden.
            prove: { noAccidents: true, oneKeeper: true, mileageUnder: 150_000 }
        };
    }

    function validateManual(body) {
        const fields = {};
        for (const [name, v] of Object.entries(body.fields ?? {})) {
            if (!(name in FIELDS)) throw new Error(`unknown field "${name}"`);
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new Error(`field "${name}" must be an integer 0..10000000`);
            fields[name] = n;
        }
        if (!Object.keys(fields).length) throw new Error('at least one field is needed');
        const updates = (Array.isArray(body.updates) ? body.updates : []).slice(0, 2).map((round) => {
            const out = {};
            for (const [name, v] of Object.entries(round ?? {})) {
                if (!(name in FIELDS)) throw new Error(`unknown field "${name}" in updates`);
                const n = Number(v);
                if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new Error(`update "${name}" must be an integer 0..10000000`);
                out[name] = n;
            }
            return out;
        }).filter((r) => Object.keys(r).length);
        const prove = {};
        for (const claim of Object.keys(CLAIM_DEFS)) {
            if (claim === 'mileageUnder') {
                const m = Number(body.prove?.mileageUnder);
                if (Number.isInteger(m) && m > 0 && m <= 10_000_000) prove.mileageUnder = m;
            } else if (body.prove?.[claim]) prove[claim] = true;
        }
        const panel = {};
        for (const [name, v] of Object.entries(body.panel ?? {})) {
            if (!(name in PANEL) || name === 'vinHash') continue;
            panel[name] = String(v).slice(0, 60);
        }
        return {
            vin: randomDemoVin(),   // ALWAYS server-generated: demos never squat a real VIN
            registrar: String(body.registrar ?? 'passport.vin-demo').slice(0, 40) || 'passport.vin-demo',
            fields, panel, updates, prove
        };
    }

    return {
        status() {
            const c = readCounter();
            return {
                enabled: true, network: NETWORK_ID, contractAddress,
                // A wedged runner is not ready, whatever the wallet says: it
                // holds a facade a cancelled run may still be using. Reporting
                // it as an error rather than a quiet refusal means the page
                // explains itself instead of the button just not working.
                ready: ready && !wedged,
                warming: !ready && !warmError && !wedged,
                error: warmError ? String(warmError.message) : wedged,
                capacity, used: c.used, remaining: Math.max(0, capacity - c.used),
                resetsAtUtc: new Date(Date.parse(todayUtc()) + 86_400_000).toISOString(),
                queueLength,
                dust: { applied: dust.applied.toString(), tip: dust.tip.toString() },
                funds: ready ? walletFunds() : null
            };
        },
        runGuided() { return enqueue('guided', guidedIntake()); },
        runManual(body) { return enqueue('manual', validateManual(body)); },
        job(id) { return jobs.get(id) ?? null; }
    };
}
