/**
 * The functional frontend, in one command:
 *
 *   npm run app        ->  http://localhost:8790
 *
 * Serves the three surfaces and runs the REAL compiled circuits in-process:
 *
 *   /            verification - scan a vehicle, see its verdicts
 *   /console/    intake - fill in the fields, submit, watch the proofs land
 *   /proofs/     proof explorer - every claim on the ledger, with status
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
const vehicles = [
    { vinHash: demo.a.vinHex, title: 'Vehicle A', blurb: 'Full service history, claims proven' },
    { vinHash: demo.b.vinHex, title: 'Vehicle B', blurb: 'A record it cannot prove clean' }
];

// ---------------------------------------------------------------- static

const MOUNTS = { '/': 'app/scan', '/console': 'app/console', '/proofs': 'app/proofs' };
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};

async function serveStatic(res, urlPath) {
    let mount = '/', rest = urlPath;
    for (const m of ['/console', '/proofs']) {
        if (urlPath === m || urlPath.startsWith(m + '/')) { mount = m; rest = urlPath.slice(m.length); break; }
    }
    if (rest === '' || rest === '/') rest = '/index.html';
    const file = normalize(join(ROOT, MOUNTS[mount], rest));
    if (!file.startsWith(normalize(join(ROOT, 'app')))) { res.writeHead(403); return res.end(); }
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

const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
};

function ledgerPayload() {
    return {
        ledger: exportLedger(sim, 'shieldvin-passport, compiled circuits run in-process by scripts/app-server.mjs'),
        vocabulary: vocabulary(vehicles)
    };
}

async function handleIntake(req, res) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) { return json(res, 413, { error: 'intake too large' }); }
    }
    let intake;
    try { intake = JSON.parse(body); }
    catch { return json(res, 400, { error: 'body is not JSON' }); }
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

// ---------------------------------------------------------------- server

createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/health') return json(res, 200, { ok: true });
    if (pathname === '/api/ledger' && req.method === 'GET') return json(res, 200, ledgerPayload());
    if (pathname === '/api/intake' && req.method === 'POST') return handleIntake(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(res, pathname);
}).listen(PORT, () => {
    console.log(`ShieldVIN app  http://localhost:${PORT}`);
    console.log(`  verification  /          console  /console/          proofs  /proofs/`);
    console.log(`  circuits: compiled shieldvin-passport, in-process; ledger resets on restart`);
});
