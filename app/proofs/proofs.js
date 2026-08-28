/**
 * Proof explorer: the whole claims ledger, grouped by vehicle.
 *
 * Every passport on the ledger gets a group: including ones with no claims,
 * because "registered, nothing proven" is a state worth seeing. Each claim is
 * marked current or superseded by comparing its recorded commitment against
 * the field's live one, which is the same check the verdict page makes.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatBound } from '../verdict.mjs';
import { loadState } from '../sources.mjs';

const app = document.getElementById('app');
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const short = (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

(async () => {
    let data;
    try {
        data = await loadState('../verify/', new URLSearchParams(location.search));
    } catch (e) {
        app.replaceChildren(el('p', 'loading', `Could not read the ledger: ${e.message}`));
        return;
    }
    const { ledger, vocabulary } = data;
    const titles = Object.fromEntries(
        (vocabulary.demoVehicles ?? []).map((v) => [v.vinHash, v.title])
    );
    const fieldMeta = vocabulary.fields;

    app.replaceChildren();
    const head = el('div', 'explorer-head');
    head.append(
        el('h1', null, 'Every claim on the ledger'),
        el('p', null,
            'Which vehicle, which field, which bound: never the value. Superseded means the ' +
            'field has moved on since the proof was made; the claim was true of an earlier version.'),
        el('p', 'src', data.badge)
    );
    app.append(head);

    const vins = Object.keys(ledger.passports);
    for (const vin of vins) {
        const group = el('section', 'vehicle-group');
        const gh = el('div', 'vg-head');
        gh.append(el('b', null, titles[vin] ?? 'Unlabelled vehicle'));
        const link = el('a');
        link.href = `../verify/?v=${vin}`;
        link.textContent = 'verdict view →';
        gh.append(link);
        group.append(gh, el('div', 'vg-hash', `VIN hash ${vin}`));

        const claims = ledger.claims.filter((c) => c.vinHash === vin);
        if (claims.length === 0) {
            group.append(el('p', 'no-claims',
                'Registered: no claims proven yet. Not a judgement; a blank page.'));
        }
        for (const c of claims) {
            const meta = fieldMeta[c.fieldKey];
            const current = ledger.fieldCommitment[c.slot] === c.commitment;
            const row = el('div', 'claim-row');
            const what = el('div', 'claim-what');
            what.append(
                el('b', null,
                    `${meta?.label ?? 'Field ' + short(c.fieldKey)} ${c.atMost ? '≤' : '≥'} ` +
                    formatBound(meta?.kind, c.bound)),
                el('small', null, `proven against ${short(c.commitment)} · slot ${short(c.slot)}`)
            );
            row.append(what, el('span', `chip ${current ? 'current' : 'superseded'}`,
                current ? 'current' : 'superseded'));
            group.append(row);
        }
        app.append(group);
    }

    const totals = el('p', 'src');
    totals.style.color = 'var(--muted)';
    totals.style.fontSize = '12.5px';
    totals.textContent =
        `${vins.length} passports · ${ledger.claims.length} claims · ${ledger.updateCount} field updates`;
    app.append(totals);
})();
