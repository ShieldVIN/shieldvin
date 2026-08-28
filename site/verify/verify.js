/**
 * Verify page wiring: render real ledger state into the hand-designed markup.
 *
 * The shipped HTML is the specification for how a verdict must look; this
 * script rebuilds the same structures from `passportView()` over the exported
 * ledger (or the live /api/ledger when `npm run app` is serving). The rules it
 * must keep are the design's rules: `.tick` only for a claim proven on the
 * ledger, `.none` for not proven (which is not a no), and no value, ever.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { passportView, QUESTIONS } from '../assets/verdict.mjs';
import { loadState } from '../assets/sources.mjs?v=3';

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (h) => `${String(h).slice(0, 10)}…${String(h).slice(-6)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TICK =
    '<span class="tick"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"></path></svg></span>';

const qLabel = (q, claim) =>
    q.field === 'odometerKm' && claim
        ? `Mileage under ${fmt(claim.bound)} km`
        : q.label;

const qSub = (a) => {
    if (a.status === 'not-proven') return 'No claim on the ledger. Not proven, not a no.';
    const bound = `${a.meta?.name ?? a.field} ${a.atMost ? '≤' : '≥'} ${fmt(a.claim.bound)}`;
    return a.status === 'proven'
        ? `${bound} · proven against the current record`
        : `${bound} · proven against an earlier version, since superseded`;
};

function detailBlock(a, open) {
    if (a.status === 'not-proven') {
        return `<div class="vp-detail"${open ? '' : ' hidden'} style="margin:0 0 16px;padding:13px 15px;border:1px solid rgba(0,74,173,.3)">
      <p style="margin:0 0 11px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.78)">Nothing on the ledger answers this question. A failed proof writes nothing and no proof was recorded, so the honest rendering is not proven. Ask the seller for it: if the claim is true of the record, producing it costs one transaction.</p>
      <a href="../intake/" style="display:inline-flex;align-items:center;justify-content:center;text-align:center;line-height:1.2;min-height:44px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:15px;letter-spacing:.06em;background:#004AAD;color:#EDE4D8;border:1px solid #004AAD;padding:10px 18px;text-decoration:none">REQUEST THIS PROOF</a>
    </div>`;
    }
    const c = a.claim;
    const cname = a.meta?.name ?? a.field ?? 'field';
    return `<div class="vp-detail"${open ? '' : ' hidden'} style="margin:0 0 16px;padding:13px 15px;border:1px solid rgba(0,74,173,.3);background:#EDE4D8">
      <p style="margin:0 0 11px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.78)">A zero-knowledge proof was accepted on the ledger. It could not have been produced unless the hidden value satisfied the bound, and the value itself was never published.</p>
      <div class="mono" style="display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:10.5px">
        <span style="color:rgba(14,23,38,.45)">claim</span><span>${esc(cname)} ${a.atMost ? '≤' : '≥'} ${fmt(c.bound)}</span>
        <span style="color:rgba(14,23,38,.45)">field key</span><span style="word-break:break-all">${short(c.fieldKey)}</span>
        <span style="color:rgba(14,23,38,.45)">proven against</span><span style="word-break:break-all">${short(c.commitment)}</span>
        <span style="color:rgba(14,23,38,.45)">ledger slot</span><span style="word-break:break-all">${short(c.slot)}</span>
      </div>
    </div>`;
}

function rowsFor(view, secondary = false) {
    const extras = (view.extras ?? []).map((x) => ({
        field: x.meta?.name, atMost: x.claim.atMost, meta: x.meta,
        label: `${x.meta?.label ?? 'Field'} ${x.claim.atMost ? 'at most' : 'at least'} ${fmt(x.claim.bound)}`,
        status: x.status, claim: x.claim
    }));
    const all = view.answers.concat(extras);
    let openAt = -1;
    if (secondary) {
        openAt = all.findIndex((a) => a.status === 'not-proven');
    } else {
        openAt = all.findIndex((a) => a.field === 'odometerKm' && a.status !== 'not-proven');
        if (openAt === -1) openAt = all.findIndex((a) => a.status !== 'not-proven');
    }
    return all.map((a, i) => {
        const proven = a.status !== 'not-proven';
        const open = i === openAt;
        const mark = proven ? TICK : '<span class="none">—</span>';
        const name = proven
            ? `<b style="display:block;font-size:15.5px">${esc(qLabel(a, a.claim))}</b>`
            : `<b style="display:block;font-size:15.5px;color:rgba(14,23,38,.78)">${esc(qLabel(a, null))}</b>`;
        return `<div class="row" style="cursor:pointer">
      ${mark}
      <div style="flex:1;min-width:0">${name}<span style="font-size:12px;color:rgba(14,23,38,.58)">${esc(qSub(a))}</span></div>
      <span class="mono vp-toggle" style="flex:none;font-size:12px;color:rgba(14,23,38,.42)">${open ? '−' : '+'}</span>
    </div>${detailBlock(a, open)}`;
    }).join('\n');
}

function scoreBand(view, secondary) {
    const proven = view.answers.filter((a) => a.status === 'proven').length;
    const total = view.answers.length;
    const all = proven === total;
    const word = proven === 1 ? 'ONE QUESTION PROVEN'
        : all ? 'BUYER QUESTIONS PROVEN' : `${proven} OF ${total} QUESTIONS PROVEN`;
    const note = all
        ? 'Each tick is a zero-knowledge proof on the ledger. No value was ever published, not to us and not to the chain.'
        : 'The rest carry no claim. That is not a no, it is the absence of a proof, and the difference matters.';
    if (all && !secondary) {
        return `<div style="margin:18px 0;padding:16px 18px;background:#004AAD;color:#EDE4D8;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:48px;line-height:.9;flex:none">${proven}<span style="opacity:.55;font-size:25px">/${total}</span></div>
      <div style="flex:1 1 190px;min-width:0"><b style="display:block;font-family:'Barlow Condensed',sans-serif;font-size:18px;letter-spacing:.03em">${word}</b>
      <span style="font-size:12px;line-height:1.45;opacity:.8">${note}</span></div></div>`;
    }
    return `<div style="margin:16px 0;padding:15px 17px;border:1px solid #8B95FF;background:rgba(139,149,255,.18);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:46px;line-height:.9;color:#004AAD;flex:none">${proven}<span style="opacity:.5;font-size:24px">/${total}</span></div>
      <div style="flex:1 1 190px;min-width:0"><b style="display:block;font-family:'Barlow Condensed',sans-serif;font-size:18px;letter-spacing:.03em">${word}</b>
      <span style="font-size:12px;line-height:1.45;color:rgba(14,23,38,.75)">${note}</span></div></div>`;
}

function statsBlock(view, vinfo, badge) {
    const battery = vinfo?.battery
        ? `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:rgba(14,23,38,.62)"><span>Battery passport</span><span class="mono">${esc(vinfo.battery)}</span></div>`
        : '';
    return `<div style="padding:16px 0;border-top:1px solid rgba(0,74,173,.26);display:flex;flex-direction:column;gap:9px">
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:rgba(14,23,38,.62)"><span>Registered by</span><span class="mono" style="text-align:right;word-break:break-all">${view.registrar ? short(view.registrar) : 'unknown'}</span></div>
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:rgba(14,23,38,.62)"><span>Claims on the ledger</span><span class="mono">${view.claimCount}</span></div>
    ${battery}
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:rgba(14,23,38,.62)"><span>Source</span><span class="mono" style="text-align:right">${esc(badge)}</span></div>
  </div>`;
}

const HONESTY =
    `<div style="padding:16px 18px;border-top:1px solid rgba(0,74,173,.26);background:rgba(0,74,173,.05);margin:0 calc(var(--edge) * -1)">
    <b style="display:block;font-family:'Barlow Condensed',sans-serif;font-size:17px;letter-spacing:.02em;margin-bottom:7px">WHAT A TICK DOES, AND DOES NOT, MEAN</b>
    <p style="margin:0;font-size:12.5px;line-height:1.6;color:rgba(14,23,38,.72)">Proven against the anchored record, attributable to a named registrar, tamper-evident. Not a guarantee that the record matched physical reality when it was written. That is the registrar's word, which is why every passport names one.</p>
  </div>`;

function mainSection(vin, view, vinfo, badge) {
    return `<header style="padding:20px 0 14px;border-bottom:1px solid rgba(0,74,173,.16)">
    <span style="display:block;font:600 10.5px Barlow,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#002E6E">Vehicle passport · Reg (EU) 2026/1738</span>
    <h1 style="margin:5px 0 4px;font-size:clamp(28px,7vw,38px);line-height:1;letter-spacing:.01em;text-transform:uppercase">${esc(vinfo?.title ?? 'Vehicle passport')}</h1>
    <span class="mono" style="font-size:10.5px;color:rgba(14,23,38,.5);word-break:break-all">VIN HASH ${vin}</span>
  </header>
  ${scoreBand(view, false)}
  ${rowsFor(view, false)}
  ${statsBlock(view, vinfo, badge)}
  ${HONESTY}`;
}

function secondarySection(vin, view, vinfo, index) {
    return `<section id="${index === 0 ? 'b' : 'v-' + vin.slice(0, 8)}" style="margin:30px 0 0;padding-top:24px;border-top:1px solid rgba(0,74,173,.26)">
    <span style="display:block;font:600 10.5px Barlow,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#002E6E">Another passport · ${esc(vinfo?.blurb ?? 'on the same ledger')}</span>
    <h2 style="margin:5px 0 4px;font-size:clamp(24px,6vw,32px);line-height:1;letter-spacing:.01em;text-transform:uppercase">${esc(vinfo?.title ?? 'Vehicle passport')}</h2>
    <span class="mono" style="font-size:10.5px;color:rgba(14,23,38,.5);word-break:break-all">VIN HASH ${vin}</span>
    ${scoreBand(view, true)}
    ${rowsFor(view, true)}
    <p style="margin:16px 0 0;font-size:13px"><a href="../proofs/">See every claim in the proof explorer →</a></p>
  </section>`;
}

(async () => {
    const root = document.querySelector('body > div');
    const nav = root.querySelector('nav');
    const footer = root.querySelector('footer');

    let state;
    try {
        state = await loadState('', new URLSearchParams(location.search));
    } catch (e) {
        const p = document.createElement('p');
        p.style.cssText = 'padding:30px 0;font-size:14px';
        p.textContent = `Could not read the ledger: ${e.message}`;
        root.replaceChildren(nav, p, footer);
        return;
    }
    const { ledger, vocabulary } = state;
    const byVin = Object.fromEntries(
        (vocabulary.demoVehicles ?? []).map((v) => [v.vinHash, v]));

    const vins = Object.keys(ledger.passports);
    const asked = new URLSearchParams(location.search).get('v');
    const main = asked && ledger.passports[asked] ? asked : vins[0];
    const rest = vins.filter((v) => v !== main);

    const holder = document.createElement('div');
    holder.innerHTML =
        mainSection(main, passportView(ledger, main, vocabulary), byVin[main], state.badge) +
        rest.map((v, i) =>
            secondarySection(v, passportView(ledger, v, vocabulary), byVin[v], i)).join('\n');

    root.replaceChildren(nav, ...holder.children, footer);

    // +/- toggles: a row opens the detail block that follows it
    for (const row of root.querySelectorAll('.row')) {
        const detail = row.nextElementSibling;
        if (!detail || !detail.classList.contains('vp-detail')) continue;
        row.addEventListener('click', () => {
            detail.hidden = !detail.hidden;
            const t = row.querySelector('.vp-toggle');
            if (t) t.textContent = detail.hidden ? '+' : '−';
        });
    }
})();
