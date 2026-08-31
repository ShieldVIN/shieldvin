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

/**
 * A step's public shape. `running` is the only state that animates, and it
 * animates by wording rather than motion: the design carries no spinners.
 */
const MARK = {
    pending: { glyph: '·', color: 'rgba(14,23,38,.35)', border: '1px dashed rgba(14,23,38,.3)', bg: 'transparent' },
    running: { glyph: '»', color: '#EDE4D8', border: '1px solid #004AAD', bg: '#004AAD' },
    done: { glyph: '✓', color: '#EDE4D8', border: '1px solid #004AAD', bg: '#004AAD' },
    failed: { glyph: '×', color: '#0E1726', border: '1px solid #8B95FF', bg: '#8B95FF' }
};

function stepRow(step) {
    const m = MARK[step.status] ?? MARK.pending;
    const detail = step.detail
        ? `<div class="mono" style="margin-top:3px;font-size:10.5px;line-height:1.5;color:rgba(14,23,38,.55);overflow-wrap:anywhere">${esc(step.detail)}</div>`
        : '';
    return `<div style="display:flex;gap:12px;padding:11px 15px;border-top:1px solid rgba(0,74,173,.12);align-items:flex-start">
      <span style="flex:none;width:22px;height:22px;display:grid;place-items:center;font-size:12px;line-height:1;
        border:${m.border};background:${m.bg};color:${m.color}">${m.glyph}</span>
      <div style="flex:1 1 220px;min-width:0">
        <b style="display:block;font-size:13.5px;font-weight:${step.status === 'running' ? 700 : 500};line-height:1.4">${esc(step.label)}</b>
        ${detail}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- receipt

function receiptPanel(job, base) {
    const r = job.receipt;
    if (!r) return '';
    // The hash is shown, not linked: preprod has no block explorer to send
    // anyone to, and the honest way to check is the indexer query the page
    // prints in full. The title carries the untruncated hash for copying.
    const txRows = (r.onChain ?? []).map((t) => `<div style="display:flex;flex-wrap:wrap;gap:3px 12px;padding:9px 15px;border-top:1px solid rgba(0,74,173,.12)">
        <span style="flex:1 1 200px;min-width:0;font-size:13px">${esc(t.label)}</span>
        <span class="mono" style="flex:none;font-size:10.5px;color:#004AAD" title="${esc(t.txHash)}">${esc(short(t.txHash))}</span>
        <span class="mono" style="flex:none;font-size:10.5px;color:rgba(14,23,38,.5)">block ${esc(t.blockHeight)}</span>
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
    const headline = job.status === 'queued' ? 'Queued'
        : job.status === 'running' ? 'Running on preprod'
            : job.status === 'failed' ? 'Stopped'
                : 'Complete';
    const sub = job.status === 'failed'
        ? esc(job.error ?? 'the run did not finish')
        : done
            ? 'Every transaction below is on the public preprod chain.'
            : 'Real proving, real fees, real blocks. This takes a few minutes.';

    host.innerHTML = `<section style="border:1px solid rgba(0,74,173,.26)">
      <div style="padding:12px 15px;border-bottom:1px solid rgba(0,74,173,.26);display:flex;flex-wrap:wrap;align-items:baseline;gap:8px">
        <h3 style="margin:0;font-size:19px;letter-spacing:.02em;text-transform:uppercase">${esc(headline)}</h3>
        <span class="mono" style="margin-left:auto;font-size:11px;color:rgba(14,23,38,.55)">${esc(job.kind)} run · ${esc(job.id.slice(0, 8))}</span>
      </div>
      <p style="margin:0;padding:11px 15px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.72);border-bottom:1px solid rgba(0,74,173,.12)">${sub}</p>
      ${(job.steps ?? []).map(stepRow).join('')}
    </section>
    ${receiptPanel(job, base)}`;
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
    return `${status.remaining} of ${status.capacity} runs left today. The count resets at ${when}.`;
}
