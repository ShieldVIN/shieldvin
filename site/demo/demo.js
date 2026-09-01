/**
 * Guided demo wiring.
 *
 * The page is honest about all four states it can be in: no server answering,
 * a wallet still catching up, today's runs spent, or ready. Each one says what
 * it is and what would change it, and the button reflects it rather than
 * failing on click.
 *
 * A run in flight survives a reload: the job id goes in the URL, so the
 * follower picks the same run back up instead of starting a second one.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { apiBase, getStatus, startGuided, followJob, capacityLine } from '../assets/preprod-run.mjs?v=4';

const $ = (id) => document.getElementById(id);
const goBtn = $('go');
const goNote = $('gonote');
const runHost = $('run');
const capDot = $('capdot');
const capState = $('capstate');
const capLine = $('capline');

let base = null;
let busy = false;

const disable = (why) => {
    goBtn.disabled = true;
    goBtn.style.opacity = '.45';
    goBtn.style.cursor = 'not-allowed';
    goBtn.title = why;
};
const enable = () => {
    goBtn.disabled = false;
    goBtn.style.opacity = '';
    goBtn.style.cursor = 'pointer';
    goBtn.title = '';
};

function paintStatus(status) {
    // `unreachable` means the engine is there but not answering yet - it
    // restores a large wallet on start. That is a different thing from the
    // feature being off, and the page must not confuse the two.
    if (status?.unreachable) {
        capDot.style.background = '#8B95FF';
        capState.textContent = 'Preprod engine busy';
        capLine.textContent = 'Not answering right now: it blocks while it restores its wallet, and again while it generates a proof. This page enables itself once it replies.';
        if (!busy) {
            disable('The preprod engine is not answering yet.');
            goNote.textContent = 'checking again every 20 seconds';
        }
        return;
    }
    capLine.textContent = capacityLine(status);
    const ready = status?.enabled && status?.ready && !status?.error;
    const spent = ready && status.remaining <= 0;
    // The daily cap is not the only thing that can stop a run. Starting one
    // with an empty wallet spends a slot to fail at the first fee, so treat
    // no dust exactly like no runs left.
    const broke = ready && status.funds?.dust != null && BigInt(status.funds.dust) === 0n;
    capDot.style.background = ready && !spent && !broke ? '#004AAD' : '#8B95FF';
    capState.textContent = !status?.enabled ? 'Preprod runs are off here'
        : status.error ? 'Preprod runs unavailable'
            : !status.ready ? 'Wallet syncing'
                : broke ? 'Out of dust'
                    : spent ? "Today's runs are used"
                        : 'Connected to preprod';
    if (status?.contractAddress) {
        $('addr').textContent = status.contractAddress;
        // Point the explorer link at THIS contract rather than the explorer's
        // front page, so "read it in a browser" lands on our contract's calls.
        const link = $('explorerlink');
        if (link) link.href = `https://preprod.midnightexplorer.com/contracts/${encodeURIComponent(status.contractAddress)}`;
    }

    if (busy) return;
    if (!ready) {
        disable(!status?.enabled
            ? 'This server does not run preprod demos.'
            : status.error ? status.error
                : 'The signing wallet is still catching up to the chain tip.');
        goNote.textContent = status?.enabled && !status.ready
            ? 'the wallet is catching up; this page will enable itself'
            : 'the manual console still runs the circuits locally';
    } else if (broke) {
        disable('The signing wallet has no dust, so a run cannot pay its first fee.');
        goNote.textContent = 'the wallet needs dust before a run can start';
    } else if (spent) {
        disable('Today\'s runs are used. The counter resets at 00:00 UTC.');
        goNote.textContent = 'the counter resets at 00:00 UTC';
    } else {
        enable();
        goNote.textContent = `${status.remaining} left today · a run writes permanent public state`;
    }
}

let lastStatus = null;
async function refreshStatus() {
    try { lastStatus = await getStatus(base); }
    catch (e) { lastStatus = e.unreachable ? { unreachable: true } : { enabled: false }; }
    paintStatus(lastStatus);
    return lastStatus;
}

/** Keep checking while the engine is warming, so the page heals itself. */
function watchUntilReady() {
    setInterval(async () => {
        if (busy) return;
        const s = lastStatus;
        if (s?.unreachable || (s?.enabled && !s?.ready)) await refreshStatus();
    }, 20000);
}

async function follow(jobId) {
    busy = true;
    disable('A run is already in flight.');
    goBtn.textContent = 'RUNNING…';
    goNote.textContent = 'leave this page open; the run continues on the server either way';
    try {
        await followJob(base, jobId, runHost);
    } catch { /* followJob already explained itself in the panel */ }
    finally {
        busy = false;
        goBtn.textContent = 'RUN THE GUIDED DEMO';
        await refreshStatus();
    }
}

goBtn.addEventListener('click', async () => {
    if (busy || goBtn.disabled) return;
    busy = true;
    disable('Starting…');
    goBtn.textContent = 'STARTING…';
    let started;
    try {
        started = await startGuided(base);
    } catch (e) {
        busy = false;
        runHost.innerHTML = `<section style="border:1px solid #8B95FF;background:rgba(139,149,255,.16);padding:13px 15px">
          <b style="font-size:14px">The run did not start.</b>
          <p style="margin:5px 0 0;font-size:13px;line-height:1.55;color:rgba(14,23,38,.85)">${e.message}</p>
        </section>`;
        goBtn.textContent = 'RUN THE GUIDED DEMO';
        await refreshStatus();
        return;
    }
    // Put the run in the URL so a reload rejoins it instead of starting another.
    const url = new URL(location.href);
    url.searchParams.set('job', started.jobId);
    history.replaceState(null, '', url);
    busy = false;
    await follow(started.jobId);
});

(async () => {
    try { base = await apiBase(); }
    catch {
        paintStatus({ enabled: false });
        capLine.textContent = 'No circuit server is answering. The guided demo needs api.passport.vin.';
        return;
    }
    await refreshStatus();
    watchUntilReady();
    const existing = new URLSearchParams(location.search).get('job');
    if (existing) await follow(existing);
})();
