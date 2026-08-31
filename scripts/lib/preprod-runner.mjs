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
const CONFIRM_TIMEOUT_MS = 240_000;
const JOB_CEILING_MS = 20 * 60_000;

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
                    // sub-code is the whole diagnosis: 188 is the sequencing
                    // (causality) refusal, the dust codes are 117/170.
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
            if (!s) { s = { id, label, status: 'pending', detail: '' }; job.steps.push(s); }
            else { s.status = 'pending'; s.detail = ''; s.label = label; }
            return s;
        };
        const runStep = async (s, fn) => {
            s.status = 'running'; job.touch();
            try { const v = await fn(); s.status = 'done'; job.touch(); return v; }
            catch (e) { s.status = 'failed'; s.detail = String(e?.message ?? e); job.touch(); throw e; }
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
        await runStep(step('wallet', 'Wallet at chain tip, dust ready'), async () => {
            await warmup;
            if (warmError) throw warmError;
            await gateToTip(10 * 60_000);
        });

        const stagesOut = [];
        const queue = [...plan.stages];
        let n = 0;
        while (queue.length) {
            const stage = queue.shift();
            n += 1;
            const calls = stage.steps.map(toCall);

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
                    const batchy = /1010|causality|segment ordering|BatchCausality/i.test(msg);
                    if (!batchy) throw e;
                    if (stage.steps.length > 1 && attempt >= 2) {
                        log(`demo: batch of ${stage.steps.length} refused twice (${msg}); splitting into single calls`);
                        queue.unshift(...stage.steps.map((s) => makeStage([s])));
                        for (const id of [`build:${n}`, `fund:${n}`, `submit:${n}`]) {
                            const row = job.steps.find((x) => x.id === id);
                            if (row?.status === 'failed') row.detail = 'batch refused by the node; retrying these calls one transaction at a time';
                        }
                        split = true;
                        break;
                    }
                    if (attempt < 3) {
                        log(`demo: stage ${n} rejected by the node (attempt ${attempt}); rebuilding`);
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
                while (Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 10_000));
                    const a = await latestContractAction();
                    if (a && a.type === 'ContractCall' && (!baseline || a.hash !== baseline.hash || a.height > baseline.height)) return a;
                }
                throw new Error('not visible on the indexer within 4 minutes (it may still land; check the contract address)');
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
            const built = await runStep(step(`build:${n}`, `Prove ${stage.label} (${calls.length} call${calls.length === 1 ? '' : 's'}, in-process)${suffix}`), async () => {
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

            const finalized = await runStep(step(`fund:${n}`, 'Pay the fee in dust (our wallet)'), async () => {
                const bytes = Uint8Array.from(Buffer.from(built.finalizedTxB64, 'base64'));
                let tx = null;
                for (const tags of [['signature', 'proof', 'binding'], ['signature', 'proof', 'pre-binding']]) {
                    try { tx = Transaction.deserialize(...tags, bytes); if (tx) break; } catch { }
                }
                if (!tx) throw new Error('could not deserialize the built transaction');
                const attempt = async () => {
                    // Every stage spends a dust UTXO; the wallet must have seen
                    // the previous stage's spend before it picks the next one.
                    await gateToTip(10 * 60_000);
                    const recipe = await facade.balanceFinalizedTransaction(
                        tx, { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
                        { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
                    );
                    return facade.finalizeRecipe(recipe);
                };
                try { return await attempt(); }
                catch (e) {
                    // A stale dust root reads as an invalid-transaction reject:
                    // re-gate to tip once and retry before giving up.
                    if (!/1010|invalid|stale/i.test(String(e?.message ?? e))) throw e;
                    await gateToTip(10 * 60_000);
                    return attempt();
                }
            });

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
                job.status = 'running'; job.touch();
                await Promise.race([
                    executeRun(job, intake),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('run exceeded the 20 minute ceiling')), JOB_CEILING_MS))
                ]);
            })
            .catch((e) => {
                if (job.status !== 'done' && job.status !== 'done-with-refusals') {
                    job.status = 'failed'; job.error = String(e?.message ?? e); job.touch();
                    log('demo: run failed:', job.error);
                }
            })
            .finally(() => { queueLength -= 1; });
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
                dust: { applied: dust.applied.toString(), tip: dust.tip.toString() }
            };
        },
        runGuided() { return enqueue('guided', guidedIntake()); },
        runManual(body) { return enqueue('manual', validateManual(body)); },
        job(id) { return jobs.get(id) ?? null; }
    };
}
