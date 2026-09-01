/**
 * The functional frontend, in one command:
 *
 *   npm run app        ->  http://localhost:8790
 *
 * Serves every site surface and runs the REAL compiled circuits in-process:
 *
 *   /            home - the problem and the mechanism
 *   /regulation/ what Reg (EU) 2026/1738 actually requires
 *   /verify/     verification - scan a vehicle, see its verdicts
 *   /intake/     intake - fill in the fields, submit, watch the proofs land
 *   /proofs/     proof explorer - every claim on the ledger, with status
 *   /demo/       the guided run against the DEPLOYED preprod contract
 *   /console/    a redirect to /intake/, kept because the old url was shared
 *
 *   POST /api/intake   run an intake through the circuits (register, record,
 *                      prove). Refusals are results: a step the circuit
 *                      rejects writes nothing and is reported as refused.
 *   GET  /api/ledger   the public ledger as an observer would see it -
 *                      commitments and claims, never a value or a VIN
 *   GET  /api/health   {"ok":true}
 *
 * Zero dependencies beyond Node itself, by design (D11's spirit): a judge
 * clones, installs, and has the full flow running in one command. The ledger
 * lives in memory, seeded with the two demo vehicles; restarting resets it.
 * Values submitted through the console exist only inside this process - the
 * export they produce is the same shape the chain would show.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import {
    PassportSimulator, buildDemoVehicles, applyIntake, exportLedger, vocabulary, saltStream
} from './lib/scenario.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8790);

// ---------------------------------------------------------------- state

const sim = new PassportSimulator();
const salt = saltStream();
const demo = buildDemoVehicles(sim, salt);

// ------------------------------------------------------------ preprod demo
// Off by default: `npm run app` stays the dependency-light judge path. With
// VINPASSPORT_PREPROD=1 (plus the seed file and wallet snapshots the runner
// documents), /api/demo/* runs REAL transactions against the deployed
// contract - capped per UTC day, one at a time, fresh random VPD VINs.
const DEMO_ENABLED = process.env.VINPASSPORT_PREPROD === '1';
let runner = null;
let runnerError = null;
if (DEMO_ENABLED) {
    import('./lib/preprod-runner.mjs')
        .then((m) => m.createRunner({ log: console.log }))
        .then((r) => { runner = r; })
        .catch((e) => { runnerError = e; console.error('preprod demo failed to start:', e.message); });
}
const vehicles = [
    { vinHash: demo.a.vinHex, title: 'Vehicle A', blurb: 'Full service history, claims proven' },
    { vinHash: demo.b.vinHex, title: 'Vehicle B', blurb: 'A record it cannot prove clean' }
];

// ---------------------------------------------------------------- static

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
    '.mp4': 'video/mp4'
};

async function serveStatic(res, urlPath) {
    // The published site is the single source: every path resolves under site/,
    // and a directory path serves its index.html, exactly as Pages does.
    let rest = urlPath;
    if (!rest.slice(rest.lastIndexOf('/')).includes('.')) {
        rest = rest.endsWith('/') ? rest + 'index.html' : rest + '/index.html';
    }
    const file = normalize(join(ROOT, 'site', rest));
    if (!file.startsWith(normalize(join(ROOT, 'site')))) { res.writeHead(403); return res.end(); }
    try {
        const body = await readFile(file);
        const ext = file.slice(file.lastIndexOf('.'));
        res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
}

// ---------------------------------------------------------------- api

// Serialise BEFORE committing to a status code. Writing the header first and
// stringifying after means a value that cannot be represented sends a 200 with
// an empty body - a caller then fails on parse and has nothing to report,
// which is a worse outcome than a plain 500 saying what happened.
const json = (res, code, obj) => {
    let body;
    try {
        body = JSON.stringify(obj);
    } catch (e) {
        console.error('demo: response could not be serialised:', String(e?.message ?? e));
        body = JSON.stringify({ error: 'response could not be serialised' });
        code = 500;
    }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
};

function ledgerPayload() {
    return {
        ledger: exportLedger(sim, 'vinpassport, compiled circuits run in-process by scripts/app-server.mjs'),
        vocabulary: vocabulary(vehicles)
    };
}

async function readJson(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) throw Object.assign(new Error('body too large'), { code: 413 });
    }
    try { return body ? JSON.parse(body) : {}; }
    catch { throw Object.assign(new Error('body is not JSON'), { code: 400 }); }
}

async function handleIntake(req, res) {
    let intake;
    try { intake = await readJson(req); }
    catch (e) { return json(res, e.code ?? 400, { error: e.message }); }
    for (const req of ['vin', 'registrar', 'fields']) {
        if (!intake[req]) return json(res, 400, { error: `missing "${req}"` });
    }
    const result = applyIntake(sim, intake, salt);
    if (!vehicles.some((v) => v.vinHash === result.vinHex) &&
        result.applied.includes('registerPassport')) {
        vehicles.push({
            vinHash: result.vinHex,
            title: String(intake.label || 'Added vehicle').slice(0, 60),
            blurb: 'Added through the intake console'
        });
    }
    // The response carries results and public identifiers only - the values
    // stay in this process, exactly as they would stay in a wallet.
    json(res, 200, result);
}

// Per-caller share of the daily cap.
//
// The global cap bounds what the wallet spends in a day; this bounds what any
// one caller may take of it, so the day's runs are still there for the next
// visitor. Open to anyone by design - a stranger clicking it is the point.
const PER_IP_RUNS = Number(process.env.VINPASSPORT_PER_IP_RUNS ?? 2);
const ipRuns = new Map();          // ip -> { date, used }

const isLocal = (a) => !a || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

const callerIp = (req) => {
    const sock = req.socket?.remoteAddress ?? '';
    // Forwarding headers are only meaningful from our own proxy; from anyone
    // else the socket is the answer.
    if (!isLocal(sock)) return sock || 'unknown';
    // Our proxy appends the address it observed, so the last hop is the one
    // it vouched for. Earlier entries arrived with the request and carry no
    // authority. This also holds for a proxy that overwrites rather than
    // appends, where there is only one entry.
    const hops = String(req.headers['x-forwarded-for'] ?? '')
        .split(',').map((h) => h.trim()).filter(Boolean);
    return hops.length ? hops[hops.length - 1] : (sock || 'unknown');
};

function takeIpSlot(req) {
    const today = new Date().toISOString().slice(0, 10);
    const ip = callerIp(req);
    const rec = ipRuns.get(ip);
    const cur = rec && rec.date === today ? rec : { date: today, used: 0 };
    if (cur.used >= PER_IP_RUNS) {
        throw Object.assign(
            new Error(`you have started ${cur.used} runs today; each run writes permanent public state, ` +
                'so the rest of the day\'s runs are left for other visitors. The counter resets at 00:00 UTC.'),
            { code: 'CAP' });
    }
    cur.used += 1;
    ipRuns.set(ip, cur);
    if (ipRuns.size > 5000) {      // bounded: drop the oldest entry
        ipRuns.delete(ipRuns.keys().next().value);
    }
    return () => { cur.used -= 1; };   // give it back if the run never started
}

// The preprod demo API. Every route degrades honestly: disabled mode says so,
// a warming wallet says so, a spent daily cap says so with the reset time.
async function handleDemo(req, res, url) {
    const path = url.pathname;
    if (path === '/api/demo/status') {
        if (!DEMO_ENABLED) return json(res, 200, { enabled: false });
        if (runnerError) return json(res, 200, { enabled: true, ready: false, error: runnerError.message });
        if (!runner) return json(res, 200, { enabled: true, ready: false, warming: true });
        return json(res, 200, runner.status());
    }
    if (!DEMO_ENABLED) return json(res, 503, { error: 'preprod demo mode is not enabled on this server' });
    if (runnerError) return json(res, 503, { error: 'preprod demo failed to start: ' + runnerError.message });
    if (!runner) return json(res, 503, { error: 'preprod demo is still starting; try again shortly' });

    if ((path === '/api/demo/run' || path === '/api/demo/intake') && req.method === 'POST') {
        let body;
        try { body = await readJson(req); }
        catch (e) { return json(res, e.code ?? 400, { error: e.message }); }
        let giveBack;
        try { giveBack = takeIpSlot(req); }
        catch (e) { return json(res, 429, { error: String(e.message ?? e) }); }
        try {
            const job = path === '/api/demo/run' ? runner.runGuided() : runner.runManual(body);
            return json(res, 202, { jobId: job.id, status: job.status, remaining: runner.status().remaining });
        } catch (e) {
            // The run never started, so it should not count against them.
            giveBack();
            const code = e.code === 'CAP' ? 429 : e.code === 'TOO_LARGE' ? 400 : 400;
            return json(res, code, { error: String(e.message ?? e) });
        }
    }
    if (path === '/api/demo/job' && req.method === 'GET') {
        const job = runner.job(url.searchParams.get('id') ?? '');
        if (!job) return json(res, 404, { error: 'unknown job' });
        return json(res, 200, job);
    }
    if (path === '/api/demo/report' && req.method === 'GET') {
        const job = runner.job(url.searchParams.get('id') ?? '');
        if (!job) return json(res, 404, { error: 'unknown job' });
        if (!job.receipt) return json(res, 409, { error: 'no report yet: job is ' + job.status + (job.error ? ' (' + job.error + ')' : '') });
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="vinpassport-demo-${job.receipt.vin}.json"`
        });
        return res.end(JSON.stringify(job.receipt, null, 2));
    }
    return json(res, 404, { error: 'unknown demo endpoint' });
}

// ---------------------------------------------------------------- server

// The published site lives on passport.vin (GitHub Pages) while /api/ lives
// here; the browser needs these headers before it lets that page call us.
const CORS_ORIGINS = new Set(['https://passport.vin', 'https://www.passport.vin']);
function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        // `Date` is not one of the headers a cross-origin page may read by
        // default, and the run page's clock needs it: it is the only true
        // server "now" the page ever sees, and without it the clock has to
        // trust the viewer's own, which may be minutes out.
        res.setHeader('access-control-expose-headers', 'date');
    }
}

// One request must not be able to end the process. The handler is async, so
// anything thrown inside it becomes a rejected promise that nothing awaits,
// and Node ends the process on an unhandled rejection - which is how a single
// GET took the demo engine down mid-run, along with the run it was reporting
// on. A failed request is a 500; the engine keeps the wallet and the queue.
const server = createServer((req, res) => {
    route(req, res).catch((e) => {
        console.error('demo: request failed:', String(e?.stack ?? e));
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else try { res.end(); } catch { /* client already gone */ }
    });
});

async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    if (pathname.startsWith('/api/')) {
        cors(req, res);
        if (req.method === 'OPTIONS') {
            res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
            res.setHeader('access-control-allow-headers', 'content-type');
            res.setHeader('access-control-max-age', '86400');
            res.writeHead(204);
            return res.end();
        }
    }
    if (pathname === '/api/health') return json(res, 200, { ok: true });
    if (pathname === '/api/ledger' && req.method === 'GET') return json(res, 200, ledgerPayload());
    if (pathname === '/api/intake' && req.method === 'POST') return handleIntake(req, res);
    if (pathname.startsWith('/api/demo/')) return handleDemo(req, res, url);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(res, pathname);
}

// A busy port greets nobody with a stack trace: walk forward a few ports -
// the previous run, or another tool, may still be holding the default.
//
// NOT in preprod mode. There a busy port means an instance is already
// running, and exactly one process may hold the wallet state. The
// convenience is worth a stack trace; a second wallet is not.
let port = PORT;
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !DEMO_ENABLED && port < PORT + 10) {
        console.log(`port ${port} is in use, trying ${port + 1}…`);
        server.listen(++port);
    } else if (e.code === 'EADDRINUSE' && DEMO_ENABLED) {
        console.error(`port ${port} is already in use, and VINPASSPORT_PREPROD=1.`);
        console.error('Refusing to start a second instance against the same wallet state.');
        console.error('Stop the running instance first (systemctl stop vinpassport-demo).');
        process.exit(1);
    } else {
        console.error(e.message);
        process.exit(1);
    }
});
server.listen(port, () => {
    console.log(`VINPassport app  http://localhost:${port}`);
    console.log(`  site  /       verify  /verify/       intake  /intake/       proofs  /proofs/`);
    console.log(`  circuits: compiled vinpassport, in-process; ledger resets on restart`);
});
