/**
 * Proof explorer wiring: the whole claims ledger, grouped by vehicle,
 * rendered into the hand-designed markup.
 *
 * Every passport gets a section, including ones with no claims, because
 * "registered, nothing proven" is a state worth seeing. A claim is current
 * when its recorded commitment still matches the field's live one, which is
 * the same check the verify page makes.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { loadState } from '../assets/sources.mjs?v=3';

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (h) => `${String(h).slice(0, 10)}…${String(h).slice(-6)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const claimTitle = (meta, c) => {
    // No meta means the claim's fieldKey is not a canonical VINPassport field.
    // Name it as invalid rather than lending it a generic "Field" label — a
    // forged key (e.g. "odometerKm " with a trailing space) must not read as real.
    if (!meta) return `⚠ Unrecognised field key ${short(c.fieldKey)} — not canonical`;
    const label = meta.label ?? 'Field';
    const op = c.atMost ? '≤' : '≥';
    const suffix = meta.kind === 'km' ? ' km' : '';
    return `${label} ${op} ${fmt(c.bound)}${suffix}`;
};

function claimRow(meta, c, current, last) {
    return `<div class="claim"${last ? ' style="border-bottom:none"' : ''}>
      <div style="flex:1 1 240px;min-width:0"><b style="display:block;font-size:14.5px">${esc(claimTitle(meta, c))}</b><span class="mono" style="font-size:10.5px;color:rgba(14,23,38,.55)">${esc(meta?.name ?? short(c.fieldKey))} · slot ${short(c.slot)} · proven against ${short(c.commitment)}</span></div>
      <span class="chip ${current ? 'chip-cur' : 'chip-sup'}">${current ? 'current' : 'superseded'}</span>
    </div>`;
}

function vehicleSection(vin, claims, ledger, vinfo, fields) {
    const currentCount = claims.filter((c) => ledger.fieldCommitment[c.slot] === c.commitment).length;
    const summary = claims.length === 0
        ? 'registered · no claims proven yet'
        : currentCount === claims.length
            ? `${claims.length} claim${claims.length === 1 ? '' : 's'} · all current`
            : `${claims.length} claims · ${claims.length - currentCount} superseded`;
    const sub = vinfo?.blurb ? `${summary}` : summary;
    const body = claims.length === 0
        ? '<p style="margin:0;padding:12px 15px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.68)">Registered, nothing proven yet. Not a judgement; a blank page. A failed proof writes nothing, and absence of a claim is rendered as absence, never as a quiet no.</p>'
        : claims.map((c, i) => claimRow(fields[c.fieldKey], c,
            ledger.fieldCommitment[c.slot] === c.commitment, i === claims.length - 1)).join('\n');
    const note = vinfo?.blurb && claims.length > 0 && currentCount !== 0 && claims.length < 4
        ? `<p style="margin:0;padding:12px 15px;font-size:13px;line-height:1.55;color:rgba(14,23,38,.68)">${esc(vinfo.blurb)}. Claims not on this list were <b>not requested</b> or would have aborted in-circuit. Absence of a claim is what the verdict page renders, never a quiet no.</p>`
        : '';
    return `<section style="border:1px solid rgba(0,74,173,.26);margin-bottom:22px">
    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;padding:13px 15px;border-bottom:1px solid rgba(0,74,173,.26)">
      <b style="font-family:'Barlow Condensed',sans-serif;font-size:21px;letter-spacing:.02em">${esc((vinfo?.title ?? 'UNLABELLED VEHICLE').toUpperCase())}</b>
      <span style="font-size:12px;color:rgba(14,23,38,.55)">${esc(sub)}</span>
      <a href="../verify/?v=${vin}" style="margin-left:auto;font-size:13px;text-decoration:none;white-space:nowrap">Verdict view →</a>
    </div>
    <div class="mono" style="padding:9px 15px;font-size:10.5px;color:rgba(14,23,38,.5);word-break:break-all;border-bottom:1px solid rgba(0,74,173,.18)">VIN HASH ${vin}</div>
    ${body}
    ${note}
  </section>`;
}

(async () => {
    let state;
    try {
        state = await loadState('../verify/', new URLSearchParams(location.search));
    } catch (e) {
        const host = document.querySelector('body > div');
        const p = document.createElement('p');
        p.style.cssText = 'padding:30px 0;font-size:14px';
        p.textContent = `Could not read the ledger: ${e.message}`;
        host.querySelector('header').after(p);
        return;
    }
    const { ledger, vocabulary } = state;
    const byVin = Object.fromEntries((vocabulary.demoVehicles ?? []).map((v) => [v.vinHash, v]));

    // stats grid: passports · claims · field updates · values published (0 by construction)
    const cells = document.querySelectorAll('div[style*="grid-template-columns"] > div > div:first-child');
    const vins = Object.keys(ledger.passports);
    if (cells.length >= 4) {
        cells[0].textContent = String(vins.length);
        cells[1].textContent = String(ledger.claims.length);
        cells[2].textContent = String(ledger.updateCount);
        cells[3].textContent = '0';
    }

    // vehicle sections: replace the two static examples with the real ledger
    const statics = [...document.querySelectorAll('body > div > section')];
    const legend = document.querySelector('div[style*="Legend"], div');
    const holder = document.createElement('div');
    holder.innerHTML = vins.map((vin) =>
        vehicleSection(vin, ledger.claims.filter((c) => c.vinHash === vin),
            ledger, byVin[vin], vocabulary.fields)).join('\n');
    statics[0].before(...holder.children);
    for (const s of statics) s.remove();

    // source badge under the header
    const header = document.querySelector('body > div > header p');
    const src = document.createElement('span');
    src.className = 'mono';
    src.style.cssText = 'display:block;margin-top:8px;font-size:10.5px;color:rgba(14,23,38,.5)';
    src.textContent = state.badge;
    header.after(src);
})();
