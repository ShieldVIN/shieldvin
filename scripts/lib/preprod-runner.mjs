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
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2';
import { createTxBuilder } from '@odatano/nightgate-tx/txbuilder';
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
    async function gateToApplied(ceilingMs) {
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

    async function snapshot(reason) {
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

    const snapTimer = setInterval(() => { if (ready) snapshot('periodic'); }, 30 * 60_000);
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
    const subCode = (msg) => Number(/Custom error:\s*(\d+)/.exec(msg)?.[1] ?? NaN);

    // The fee proof itself was refused. Re-gate to the tip and prove again.
    const isStaleDustProof = (msg) => [170, 171].includes(subCode(msg));

    // The wallet genuinely cannot pay. Only these say that.
    const isFundsProblem = (msg) =>
        [138, 173].includes(subCode(msg)) ||
        /insufficient funds|could not balance dust|InvalidTransaction::Payment/i.test(msg);

    // The batch's shape is the problem, so splitting it into single calls is
    // the remedy. Nothing else here is worth splitting for.
    const isSequencingProblem = (msg) => {
        const c = subCode(msg);
        return (c >= 219 && c <= 224) || c === 188 ||
            /causality|sequencing|segment ordering|BatchCausality/i.test(msg);
    };

    // ---- submission (the path that works: encode HTTP, submit one-shot ws) -
    async function submitFinalized(finalized) {
        const { ApiPromise, HttpProvider } = await import('@polkadot/api');
        const { u8aToHex } = await import('@polkadot/util');
        const api = await ApiPromise.create({ provider: new HttpProvider(NODE_HTTP), noInitWarn: true });
        try {
            const extrinsicHex = api.tx.midnight.sendMnTransaction(u8aToHex(finalized.serialize())).toHex();
            return await new Promise((resolve, reject) => {
                const ws = new WebSocket(NODE_WS);
                const timer = setTimeout(() => { try { ws.close(); } catch { } reject(new Error('ws submit timeout (30s)')); }, 30_000);
                ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [extrinsicHex] }));
                ws.onmessage = (ev) => {
                    const m = JSON.parse(ev.data);
                    if (m.id !== 1) return;
                    clearTimeout(timer); try { ws.close(); } catch { }
                    // error.data carries the ledger's sub-code, and the
                    // sub-code is the whole diagnosis - see the table above
                    // isStaleDustProof for what each one actually means.
                    // Keep it in the message: without it a rejection is just
                    // "1010 Invalid Transaction", which says nothing.
                    if (m.error) reject(new Error(`node rejected: ${m.error.code} ${m.error.message}${m.error.data ? ' | ' + JSON.stringify(m.error.data) : ''}`));
                    else resolve(String(m.result));
                };
                ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error during submit')); };
            });
        } finally { try { await api.disconnect(); } catch { } }
    }

    // ---- one run -----------------------------------------------------------
    async function executeRun(job, intake) {
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
        const walletStep = step('wallet', 'Wallet at chain tip, dust ready');
        await runStep(walletStep, async () => {
            await warmup;
            if (warmError) throw warmError;
            // Bounded by the same warm-up budget the run publishes, so the
            // advertised budget is the truth rather than an underestimate.
            await gateToTip(WARMUP_BUDGET_MS);
            // Say what the wallet can pay with BEFORE proving anything. A run
            // that dies of dust at stage five has already spent four fees, a
            // slot from the daily cap and several minutes of the visitor's
            // attention, and left a passport half-written on a public chain.
            const bal = dustBalance();
            walletStep.detail = bal == null ? 'dust balance unavailable'
                : `dust balance ${bal}${MIN_DUST ? ` · floor ${MIN_DUST}` : ''}`;
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
            const stageEndsAt = Date.now() + STAGE_BUDGET_MS;
            const stageBudget = () => {
                if (Date.now() > stageEndsAt) {
                    throw new Error(`stage ${n} (${stage.label}) exceeded its ` +
                        `${Math.round(STAGE_BUDGET_MS / 60_000)} minute budget`);
                }
            };

            // A 1010 reject is a known batch outcome; the remedy is to REBUILD
            // with fresh randomness, never to resubmit the same bytes. If a
            // multi-call transaction keeps being refused, the batch itself is
            // the problem: split it into single calls (the shape proven to
            // land) and carry on rather than losing the run.
            let submitted = null;
            let attempt = 0;
            let split = false;
            for (; ;) {
                attempt += 1;
                try {
                    submitted = await runStageOnce(n, stage, calls, attempt);
                    break;
                } catch (e) {
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
                        stageBudget();
                        log(`demo: stage ${n} rejected by the node (attempt ${attempt}: ${msg}); rebuilding`);
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
                for (; ;) {
                    const a = await latestContractAction();
                    if (a && a.type === 'ContractCall' && (!baseline || a.hash !== baseline.hash || a.height > baseline.height)) return a;
                    if (Date.now() >= deadline) break;
                    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
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

        async function runStageOnce(n, stage, calls, attempt) {
            const suffix = attempt > 1 ? ` (attempt ${attempt})` : '';
            // Proving is ~40s of CPU. Spending it on a transaction we already
            // know we cannot fund is the expensive way to reach the same
            // failure, so ask the wallet first.
            const before = dustBalance();
            if (before === 0n) throw Object.assign(new Error(OUT_OF_DUST), { funds: true });
            // stage.label already reads "prove noAccidents" for a single call,
            // so prefixing "Prove " again gave "Prove prove noAccidents".
            const what = /^prove /i.test(stage.label) ? stage.label : `Prove ${stage.label}`;
            const built = await runStep(step(`build:${n}`, `${what} (${calls.length} call${calls.length === 1 ? '' : 's'}, in-process)${suffix}`), async () => {
                const builder = await createTxBuilder({
                    seedHex, networkId: NETWORK_ID,
                    indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS, nodeUrl: NODE_WS,
                    provingMode: 'wasm', zkConfigDir: ZK_CONFIG_DIR,
                    contractClass: Contract, contractName: 'vinpassport',
                    privateStateId: 'vinpassport-demo',
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
                        contractAddress, calls, witnesses, initialPrivateState: {}, bind: true
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
                    // Every stage spends a dust UTXO; the wallet must have seen
                    // the previous stage's spend before it picks the next one,
                    // and "seen" has to mean level, not within a hundred.
                    await gateToApplied(GATE_TIMEOUT_MS);
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
                    await gateToApplied(GATE_TIMEOUT_MS);
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
            const extrinsicHash = await runStep(step(`submit:${n}`, 'Submit to the preprod node'), () => submitFinalized(finalized));
            return { extrinsicHash, baseline };
        }

        snapshot('post-run');

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

    function makeJob(kind) {
        const job = {
            id: randomUUID(), kind, status: 'queued', steps: [], receipt: null,
            createdAt: new Date().toISOString(), updatedAt: null, error: null,
            // The page shows a clock; the server owns it, so a reload or a
            // second viewer sees the same elapsed time rather than its own.
            startedAt: null, finishedAt: null, ms: null,
            touch() { this.updatedAt = new Date().toISOString(); }
        };
        jobs.set(job.id, job);
        if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
        return job;
    }

    function enqueue(kind, intake) {
        if (warmError) throw new Error('the preprod wallet failed to start: ' + warmError.message);
        takeSlot();                       // counts against today even if it later fails
        const job = makeJob(kind);
        queueLength += 1;
        queueTail = queueTail
            .then(async () => {
                job.status = 'running'; job.startedAt = new Date().toISOString(); job.touch();
                await Promise.race([
                    executeRun(job, intake),
                    // Backstop only. Stages carry their own deadlines, so this
                    // fires for something pathological (a wedged socket, a
                    // wallet that never syncs), not for a run that is merely
                    // slow - which is what the old flat 20 minutes did.
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error(`run exceeded the ${Math.round(JOB_CEILING_MS / 60_000)} minute backstop`)),
                        JOB_CEILING_MS))
                ]);
            })
            .catch((e) => {
                if (job.status !== 'done' && job.status !== 'done-with-refusals') {
                    job.status = 'failed'; job.error = String(e?.message ?? e); job.touch();
                    log('demo: run failed:', job.error);
                }
            })
            .finally(() => {
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
                ready, warming: !ready && !warmError,
                error: warmError ? String(warmError.message) : null,
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
