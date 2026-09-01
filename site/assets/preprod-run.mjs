/**
 * The preprod run client: start a real run, follow it, render it.
 *
 * One module serves both surfaces, so the guided page and the intake console
 * cannot drift: /demo/ starts a run the server composes, /intake/ starts one
 * the registrar filled in, and from the first poll onwards the two are the
 * same thing - the same steps, the same receipt, the same honesty about a
 * refusal.
 *
 * The rendering follows the site's grammar exactly: hairline rules, square
 * corners, monospace for anything a machine produced, periwinkle reserved for
 * refusals and demo marks. Nothing here invents a new visual idea.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolveApiBase } from './sources.mjs?v=3';

const POLL_MS = 3000;
// Preprod's block explorer. Paths verified against a real run's transaction on
// 2026-08-31: /transactions/<hash>, /blocks/<height> and /contracts/<address>
// all resolve, and all 404 on a value that does not exist - so a live link is
// worth something. No trailing slash.
const EXPLORER = 'https://preprod.midnightexplorer.com';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (h) => `${String(h).slice(0, 12)}…${String(h).slice(-8)}`;

/**
 * GET/POST helper that turns a non-2xx into the server's own message.
 *
 * The timeout is not decoration: restoring the signing wallet is heavy
 * synchronous work, so the demo service accepts connections before it can
 * answer them. Without a deadline the page would hang on a request that is
 * going to be answered eventually, instead of saying "still starting".
 */
async function call(base, path, init, timeoutMs = 15000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let r;
    try {
        r = await fetch(`${base}${path}`, {
            cache: 'no-store',
            signal: abort.signal,
            ...init,
            headers: init?.body ? { 'content-type': 'application/json' } : undefined
        });
    } catch (e) {
        throw Object.assign(
            new Error(e?.name === 'AbortError' ? 'the preprod service did not answer in time' : 'could not reach the preprod service'),
            { unreachable: true });
    } finally { clearTimeout(timer); }
    // Every response carries a server-generated Date; it is the only honest
    // "now" the page ever sees, so the clock's skew correction comes from here.
    noteServerTime(r.headers.get('date'));
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON error page */ }
    if (!r.ok) {
        const e = new Error(body?.error ?? `the server said ${r.status}`);
        e.status = r.status;
        throw e;
    }
    return body;
}

export async function apiBase() {
    const base = await resolveApiBase();
    if (base == null) throw new Error('no circuit server is answering');
    return base;
}

export const getStatus = async (base) => call(base, '/api/demo/status');
// Starting a run is a longer wait: the request queues behind whatever the
// engine is doing, and the caller has explicitly asked for it.
export const startGuided = async (base) => call(base, '/api/demo/run', { method: 'POST', body: '{}' }, 60000);
export const startManual = async (base, intake) =>
    call(base, '/api/demo/intake', { method: 'POST', body: JSON.stringify(intake) }, 60000);

// ---------------------------------------------------------------- steps

// ---------------------------------------------------------------- clock

/**
 * Durations, in the shortest form that stays readable. Seconds below a
 * minute, then m:ss - a proof is tens of seconds and a whole run is minutes,
 * so hours never arise and are not pretended at.
 */
export function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    // Submitting takes well under a second; reporting that as "0s" reads like
    // a step that never ran.
    if (s < 1) return '<1s';
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * The server owns the clock. It timestamps every step, so a reload or a
 * second viewer sees the same elapsed time instead of starting its own; the
 * only thing done here is correcting for a viewer whose clock is off.
 *
 * The correction has to come from a genuine server NOW, which is why it is
 * taken from each response's `Date` header rather than from anything in the
 * payload. A job's `updatedAt` is when the job last CHANGED, and a stage
 * spends tens of seconds inside a single proof without changing anything: read
 * as "now" it would drift further behind on every poll, and each poll would
 * then drag the displayed time backwards while the ticker walked it forward.
 *
 * The header is whole-second and stamped before the reply travels, so it runs
 * up to a round trip behind. That is invisible on a clock that shows seconds.
 */
let skewMs = 0;
const serverNow = () => Date.now() - skewMs;
/** Elapsed since `iso`, never negative: a clock that goes backwards reads as broken. */
const since = (iso) => (iso ? Math.max(0, serverNow() - Date.parse(iso)) : null);

function noteServerTime(header) {
    if (!header) return;
    const t = Date.parse(header);
    if (Number.isFinite(t)) skewMs = Date.now() - t;
}

/** One ticker for the page: live clocks are re-rendered in place, so a poll
 *  landing between ticks cannot fight it for the DOM. */
let ticker = null;
function tick() {
    const live = document.querySelectorAll('[data-vp-since]');
    if (!live.length) { clearInterval(ticker); ticker = null; return; }
    for (const el of live) el.textContent = fmtDuration(Math.max(0, serverNow() - Number(el.dataset.vpSince)));
}
function startTicker() { if (!ticker) ticker = setInterval(tick, 1000); }

/**
 * A step's public shape. The running row is the only one that moves, and it
 * moves because a single proof blocks for tens of seconds: without it a
 * working run and a dead page look identical.
 */
const MARK = {
    pending: { glyph: '·', color: 'rgba(14,23,38,.35)', border: '1px dashed rgba(14,23,38,.3)', bg: 'transparent' },
    running: { glyph: '»', color: '#EDE4D8', border: '1px solid #004AAD', bg: '#004AAD' },
    done: { glyph: '✓', color: '#EDE4D8', border: '1px solid #004AAD', bg: '#004AAD' },
    failed: { glyph: '×', color: '#0E1726', border: '1px solid #8B95FF', bg: '#8B95FF' }
};

function stepRow(step) {
    const m = MARK[step.status] ?? MARK.pending;
    const running = step.status === 'running';
    // The confirm step's detail reads "tx <hash> in block <n>". Linking it as
    // it streams means a visitor can open the transaction while the run is
    // still going, rather than waiting for the receipt at the end. Escape
    // first, then linkify the escaped text, so this stays injection-safe.
    const linkify = (s) => esc(s)
        .replace(/\btx ([0-9a-f]{64})\b/gi,
            (_, h) => `tx <a href="${EXPLORER}/transactions/${h}" target="_blank" rel="noopener noreferrer" style="color:#004AAD">${h}</a>`)
        .replace(/\bblock (\d+)\b/g,
            (_, n) => `block <a href="${EXPLORER}/blocks/${n}" target="_blank" rel="noopener noreferrer" style="color:#004AAD">${n}</a>`);
    const detail = step.detail
        ? `<div class="mono" style="margin-top:3px;font-size:10.5px;line-height:1.5;color:rgba(14,23,38,.55);overflow-wrap:anywhere">${linkify(step.detail)}</div>`
        : '';
    // A finished step reports what it took; the running one counts up. Only
    // the running clock carries data-vp-since, so the ticker stops on its own
    // once nothing is live.
    const clock = running && step.startedAt
        ? `<span class="mono vp-clock" data-vp-since="${Date.parse(step.startedAt)}"
             style="flex:none;font-size:11px;color:#004AAD">${esc(fmtDuration(since(step.startedAt)) || '0s')}</span>`
        : step.ms != null
            ? `<span class="mono vp-clock" style="flex:none;font-size:11px;color:rgba(14,23,38,.42)">${esc(fmtDuration(step.ms))}</span>`
            : '';
    return `<div class="${running ? 'vp-run' : ''}" style="display:flex;gap:12px;padding:11px 15px;border-top:1px solid rgba(0,74,173,.12);align-items:flex-start">
      <span class="${running ? 'vp-mark-run' : ''}" style="flex:none;width:22px;height:22px;display:grid;place-items:center;font-size:12px;line-height:1;
        border:${m.border};background:${m.bg};color:${m.color}">${m.glyph}</span>
      <div style="flex:1 1 220px;min-width:0">
        <b style="display:block;font-size:13.5px;font-weight:${running ? 700 : 500};line-height:1.4">${esc(step.label)}</b>
        ${detail}
      </div>
      ${clock}
    </div>`;
}

// ---------------------------------------------------------------- receipt

function receiptPanel(job, base) {
    const r = job.receipt;
    if (!r) return '';
    // Hashes are links now. They used to be inert text because preprod had no
    // explorer to send anyone to; preprod.midnightexplorer.com covers preprod
    // as of 2026-08-31, and every url below was checked against a real
    // transaction from a real run - a hash that does not exist 404s there,
    // so a link that resolves is evidence rather than decoration.
    //
    // The indexer query stays printed in full underneath regardless: an
    // explorer is somebody else's website, and "check it yourself" should not
    // depend on one staying up.
    const txRows = (r.onChain ?? []).map((t) => `<div style="display:flex;flex-wrap:wrap;gap:3px 12px;padding:9px 15px;border-top:1px solid rgba(0,74,173,.12)">
        <span style="flex:1 1 200px;min-width:0;font-size:13px">${esc(t.label)}</span>
        <a class="mono" href="${EXPLORER}/transactions/${encodeURIComponent(t.txHash)}" target="_blank" rel="noopener noreferrer"
           style="flex:none;font-size:10.5px;color:#004AAD;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px"
           title="View ${esc(t.txHash)} on the preprod explorer">${esc(short(t.txHash))}&#8239;<span aria-hidden="true">&#8599;</span></a>
        <a class="mono" href="${EXPLORER}/blocks/${encodeURIComponent(t.blockHeight)}" target="_blank" rel="noopener noreferrer"
           style="flex:none;font-size:10.5px;color:rgba(14,23,38,.5);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px"
           title="View block ${esc(t.blockHeight)} on the preprod explorer">block ${esc(t.blockHeight)}</a>
      </div>`).join('');

    const claimRows = (r.claims ?? []).map((c) => {
        const proven = c.outcome.startsWith('proven');
        return `<div class="row" style="padding:11px 0">
          <span class="${proven ? 'tick' : 'none'}">${proven
            ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"></path></svg>'
            : '–'}</span>
          <div style="flex:1 1 220px;min-width:0">
            <b style="display:block;font-size:14px">${esc(c.label)}</b>
            <span style="font-size:12px;color:rgba(14,23,38,.62)">${esc(c.outcome)}</span>
          </div>
        </div>`;
    }).join('');

    const refusals = (r.refused ?? []).length
        ? `<div style="padding:12px 15px;border-top:1px solid rgba(0,74,173,.26);background:rgba(139,149,255,.18)">
             <b style="font-size:13px">Refused in-circuit, nothing written</b>
             ${r.refused.map((x) => `<div style="margin-top:5px;font-size:12.5px;line-height:1.55;color:rgba(14,23,38,.85)"><span class="mono" style="font-size:11px">${esc(x.step)}</span> — ${esc(x.reason)}</div>`).join('')}
           </div>`
        : '';

    return `<section style="border:1px solid rgba(0,74,173,.26);margin-top:26px">
      <div style="padding:12px 15px;border-bottom:1px solid rgba(0,74,173,.26);display:flex;flex-wrap:wrap;align-items:baseline;gap:8px">
        <h3 style="margin:0;font-size:19px;letter-spacing:.02em;text-transform:uppercase">On the chain</h3>
        <span class="mono" style="margin-left:auto;font-size:11px;color:rgba(14,23,38,.55)">${(r.onChain ?? []).length} transaction${(r.onChain ?? []).length === 1 ? '' : 's'} · preprod</span>
      </div>
      ${txRows}
      ${refusals}
      <div style="padding:14px 15px;border-top:1px solid rgba(0,74,173,.26)">
        <div class="sect" style="margin-bottom:10px"><span class="snum">A</span><h2 class="stitle">WHAT WAS PROVEN</h2></div>
        ${claimRows || '<p style="margin:0;font-size:13px;color:rgba(14,23,38,.68)">No claims were requested on this run.</p>'}
      </div>
      <div style="padding:14px 15px;border-top:1px solid rgba(0,74,173,.26)">
        <div class="sect" style="margin-bottom:10px"><span class="snum">B</span><h2 class="stitle">THE PASSPORT ITSELF</h2></div>
        <p style="margin:0 0 12px;font-size:13.5px;line-height:1.6;color:rgba(14,23,38,.82);max-width:64ch">The chain holds commitments. The values behind them, and the salts that hide them, exist only in the receipt below. Whoever holds that file can open the commitments and prove any of these values to anyone; nobody else can. That is what owning a passport means here.</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
          <a href="${base}/api/demo/report?id=${encodeURIComponent(job.id)}" download style="display:inline-flex;align-items:center;justify-content:center;text-align:center;line-height:1.2;text-decoration:none;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:15px;letter-spacing:.06em;background:#004AAD;color:#EDE4D8;padding:11px 22px">DOWNLOAD THE RECEIPT</a>
          <a href="../verify/?v=${encodeURIComponent(r.vinHash)}" style="display:inline-flex;align-items:center;justify-content:center;text-align:center;line-height:1.2;text-decoration:none;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:15px;letter-spacing:.06em;color:#0E1726;border:1px solid rgba(0,74,173,.28);padding:11px 20px">VERIFY THIS PASSPORT</a>
        </div>
        <div class="mono" style="margin-top:11px;font-size:10.5px;line-height:1.6;color:rgba(14,23,38,.5);overflow-wrap:anywhere">VIN ${esc(r.vin)} · vinHash ${esc(short(r.vinHash))} · contentRoot ${esc(short(r.contentRoot))}</div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- render

/**
 * Paint one job into `host`. Pure function of the job, so a poll that arrives
 * out of order cannot leave the panel in a half-updated state.
 */
export function renderJob(host, job, base) {
    const done = job.status === 'done' || job.status === 'done-with-refusals';
    const live = job.status === 'running' || job.status === 'queued';
    const headline = job.status === 'queued' ? 'Queued'
        : job.status === 'running' ? 'Running on preprod'
            : job.status === 'failed' ? 'Stopped'
                : 'Complete';
    // A run out of dust is not a broken run: the wallet cannot pay a fee. Say
    // which it is, because the reader can do something about one of them.
    const outOfDust = job.status === 'failed' && /out of dust|balance dust|insufficient funds/i.test(job.error ?? '');
    const sub = job.status === 'failed'
        ? (outOfDust
            ? `${esc(job.error ?? '')} Dust pays the fees here and regenerates from NIGHT registered for it, so this is a wallet top-up rather than something wrong with the passport or the circuits.`
            : esc(job.error ?? 'the run did not finish'))
        : done
            ? 'Every transaction below is on the public preprod chain.'
            : 'Real proving, real fees, real blocks. This takes a few minutes.';

    const total = live && job.startedAt
        ? `<span class="mono vp-clock" data-vp-since="${Date.parse(job.startedAt)}" style="font-size:11px;color:#004AAD">${esc(fmtDuration(since(job.startedAt)) || '0s')}</span>`
        : job.ms != null
            ? `<span class="mono vp-clock" style="font-size:11px;color:rgba(14,23,38,.55)">took ${esc(fmtDuration(job.ms))}</span>`
            : '';

    host.innerHTML = `<section style="border:1px solid rgba(0,74,173,.26)">
      <div style="padding:12px 15px;border-bottom:1px solid rgba(0,74,173,.26);display:flex;flex-wrap:wrap;align-items:baseline;gap:8px">
        <h3 style="margin:0;font-size:19px;letter-spacing:.02em;text-transform:uppercase">${esc(headline)}</h3>
        ${total}
        <span class="mono" style="margin-left:auto;font-size:11px;color:rgba(14,23,38,.55)">${esc(job.kind)} run · ${esc(job.id.slice(0, 8))}</span>
      </div>
      <p style="margin:0;padding:11px 15px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.72);border-bottom:1px solid rgba(0,74,173,.12)">${sub}</p>
      ${(job.steps ?? []).map(stepRow).join('')}
    </section>
    ${receiptPanel(job, base)}`;

    startTicker();
}

/**
 * Follow a job to its end, painting every poll. Resolves with the finished
 * job; a failed run resolves too, because a failure is a result to read, not
 * an exception to swallow.
 *
 * A poll that times out is EXPECTED, not an error: proving a circuit is
 * synchronous WASM work that blocks the server for tens of seconds at a
 * time, so the very thing the visitor is waiting for is what stops the
 * server answering. Treating the first timeout as lost contact would
 * abandon a run that is going perfectly. So a missed poll keeps the last
 * good render, says quietly that the server is busy, and carries on; only a
 * long silence is reported as a real loss.
 */
const QUIET_AFTER = 3;      // missed polls before we mention it
const GIVE_UP_AFTER = 40;   // ~2 minutes of silence, then it is real

export async function followJob(base, jobId, host, onChange) {
    let missed = 0;
    let lastJob = null;
    for (; ;) {
        let job = null;
        try {
            job = await call(base, `/api/demo/job?id=${encodeURIComponent(jobId)}`, undefined, 20000);
            missed = 0;
        } catch (e) {
            missed += 1;
            if (missed >= GIVE_UP_AFTER) {
                host.innerHTML = `<p style="margin:0;font-size:13.5px;line-height:1.6;color:rgba(14,23,38,.72)">Lost contact with the run: ${esc(e.message)}. It is still going on the server - reload this page to pick it up again.</p>`;
                throw e;
            }
            if (missed >= QUIET_AFTER) paintBusy(host, lastJob, base);
        }
        if (job) {
            lastJob = job;
            renderJob(host, job, base);
            onChange?.(job);
            if (job.status !== 'queued' && job.status !== 'running') return job;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

/** Keep the last good render and add one honest line above it. */
function paintBusy(host, lastJob, base) {
    const note = `<p style="margin:0 0 12px;padding:10px 13px;border:1px solid #8B95FF;background:rgba(139,149,255,.16);font-size:12.5px;line-height:1.55">The server has gone quiet for a moment. That is usually the proof itself: generating one blocks the server until it is done. Still following this run.</p>`;
    if (lastJob) { renderJob(host, lastJob, base); host.insertAdjacentHTML('afterbegin', note); }
    else host.innerHTML = note;
}

/** One line describing today's remaining capacity, for a status strip. */
export function capacityLine(status) {
    if (!status?.enabled) return 'Preprod runs are not enabled on this server.';
    if (status.error) return `Preprod runs are unavailable: ${status.error}`;
    if (!status.ready) return 'The signing wallet is catching up to the chain tip. Runs start once it is level.';
    const reset = status.resetsAtUtc ? new Date(status.resetsAtUtc) : null;
    const when = reset ? `${String(reset.getUTCHours()).padStart(2, '0')}:00 UTC` : '00:00 UTC';
    const line = `${status.remaining} of ${status.capacity} runs left today. The count resets at ${when}.`;
    // The daily cap is not the only thing that can stop a run. Dust pays the
    // fees, and a run that starts without enough of it writes half a passport
    // before it finds out.
    const dust = status.funds?.dust;
    if (dust != null && BigInt(dust) === 0n) return `The signing wallet is out of dust, so a run cannot pay a fee. ${line}`;
    return line;
}
