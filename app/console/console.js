/**
 * Intake console wiring.
 *
 * Two modes, decided by whether the app server answers:
 *
 *   server  the form POSTs to /api/intake, the compiled circuits run
 *           in-process, and the result lists every step the circuits
 *           accepted or REFUSED - then links straight to the vehicle's
 *           verdicts and the proof explorer.
 *   static  no server (GitHub Pages): the form produces an intake file for
 *           scripts/intake.mjs instead, and says so plainly.
 *
 * Refusals are rendered, not hidden: watching "update 2: odometerKm -> 40000
 * REFUSED - value decreased" is the integrity rule doing its job in public.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEMO_VEHICLES } from './demo-vehicles.mjs';

const form = document.getElementById('intake');
const modeText = document.getElementById('mode-text');
const updates = document.getElementById('updates');
const warning = document.getElementById('monotonic-warning');
const go = document.getElementById('go');

let serverMode = false;

// ---------------------------------------------------------------- mode

(async () => {
    try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        serverMode = r.ok;
    } catch { serverMode = false; }
    if (serverMode) {
        modeText.textContent =
            'The compiled circuits are running locally: submitting registers the passport, ' +
            'records the history and proves the claims - values stay in that process.';
    } else {
        modeText.textContent =
            'No circuit server here, so the form will produce an intake file to run with ' +
            'scripts/intake.mjs on your machine. Values stay in this page until then.';
        go.textContent = 'Generate intake file';
    }
})();

// ---------------------------------------------------------------- updates

function addUpdateRow() {
    const row = document.createElement('div');
    row.className = 'update-row';
    row.innerHTML =
        '<label>Mileage (km)<input data-u="odometerKm" type="number" min="0" step="1"></label>' +
        '<label>Services total<input data-u="serviceCount" type="number" min="0" step="1"></label>' +
        '<button type="button" class="remove" aria-label="Remove this record">✕</button>';
    row.querySelector('.remove').addEventListener('click', () => { row.remove(); checkMonotonic(); });
    row.addEventListener('input', checkMonotonic);
    updates.append(row);
}
document.getElementById('add-update').addEventListener('click', addUpdateRow);

function readUpdates() {
    return [...updates.querySelectorAll('.update-row')].map((row) => {
        const out = {};
        for (const input of row.querySelectorAll('input[data-u]')) {
            if (input.value !== '') out[input.dataset.u] = Number(input.value);
        }
        return out;
    }).filter((u) => Object.keys(u).length > 0);
}

function checkMonotonic() {
    let last = Number(form.elements.odometerKm.value || 0);
    let falls = false;
    for (const u of readUpdates()) {
        if ('odometerKm' in u) {
            if (u.odometerKm < last) falls = true;
            last = u.odometerKm;
        }
    }
    warning.hidden = !falls;
}
form.elements.odometerKm.addEventListener('input', checkMonotonic);

// The battery passport link is only meaningful when there is a battery whose
// regime it points into - a reference for EVs and plug-in hybrids, absent
// otherwise. Absence is anchored salted, so an observer cannot tell.
const evOnly = document.getElementById('ev-only');
const fuelSel = document.getElementById('fuelType');
const syncEv = () => { evOnly.hidden = !['bev', 'phev'].includes(fuelSel.value); };
fuelSel.addEventListener('change', syncEv);
syncEv();

// ---------------------------------------------------------------- demo picker

// Filling is mechanical on purpose: the demo entries mirror the form's field
// names, so an evaluator watches the same form they could have typed into.
const demoSelect = document.getElementById('demo-select');
const demoBlurb = document.getElementById('demo-blurb');
DEMO_VEHICLES.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = v.name;
    demoSelect.append(opt);
});

function fillForm(v) {
    const f = form.elements;
    f.vin.value = v.vin;
    f.registrar.value = v.registrar;
    f.label.value = v.label ?? '';
    f.vehicleCategory.value = v.vehicleCategory;
    f.fuelType.value = v.fuelType;
    syncEv();
    f.emissionsClass.value = v.emissionsClass ?? '';
    f.firstRegistrationDate.value = v.firstRegistrationDate ?? '';
    f.euTypeApprovalNumber.value = v.euTypeApprovalNumber ?? '';
    if (!evOnly.hidden) {
        f.batteryPassportId.value = v.batteryPassportId ?? '';
        f.batteryChemistry.value = v.batteryChemistry ?? '';
    }
    const env = v.env ?? {};
    for (const n of ['co2FootprintKgCO2e', 'recycledPlasticPct', 'recycledSteelPct', 'recycledAluminiumPct']) {
        f[n].value = env[n] ?? '';
    }
    document.querySelector('.env-details').open = Object.keys(env).length > 0;

    for (const [n, val] of Object.entries(v.fields)) f[n].value = val;

    updates.replaceChildren();
    for (const u of v.updates) {
        addUpdateRow();
        const row = updates.lastElementChild;
        for (const input of row.querySelectorAll('input[data-u]')) {
            if (u[input.dataset.u] !== undefined) input.value = u[input.dataset.u];
        }
    }
    checkMonotonic();

    f.neverWrittenOff.checked = v.prove.neverWrittenOff;
    f.noAccidents.checked = v.prove.noAccidents;
    f.oneKeeper.checked = v.prove.oneKeeper;
    f.mileageUnderOn.checked = v.prove.mileageUnder > 0;
    if (v.prove.mileageUnder > 0) f.mileageUnder.value = v.prove.mileageUnder;
}

demoSelect.addEventListener('change', () => {
    const v = DEMO_VEHICLES[Number(demoSelect.value)];
    if (!v) { demoBlurb.hidden = true; return; }
    fillForm(v);
    demoBlurb.textContent = v.expect;
    demoBlurb.hidden = false;
});

// ---------------------------------------------------------------- intake

function buildIntake() {
    const f = form.elements;
    const intake = {
        vin: f.vin.value.trim().toUpperCase(),
        registrar: f.registrar.value.trim(),
        fields: {
            odometerKm: Number(f.odometerKm.value),
            accidentCount: Number(f.accidentCount.value),
            ownerCount: Number(f.ownerCount.value),
            writeOffCategory: Number(f.writeOffCategory.value),
            serviceCount: Number(f.serviceCount.value)
        },
        updates: readUpdates(),
        prove: {
            neverWrittenOff: f.neverWrittenOff.checked,
            noAccidents: f.noAccidents.checked,
            oneKeeper: f.oneKeeper.checked,
            mileageUnder: f.mileageUnderOn.checked ? Number(f.mileageUnder.value) : 0
        }
    };
    if (f.label.value.trim()) intake.label = f.label.value.trim();

    // The regulation-facing declarations: anchored under the content root,
    // values private. Empty inputs are simply absent - and absent slots are
    // salted, so absence discloses nothing either.
    const panel = {};
    const put = (name, value) => { if (value !== '' && value !== undefined) panel[name] = value; };
    put('vehicleCategory', f.vehicleCategory.value);
    put('fuelType', f.fuelType.value);
    put('emissionsClass', f.emissionsClass.value);
    put('euTypeApprovalNumber', f.euTypeApprovalNumber.value.trim());
    if (!evOnly.hidden) {
        put('batteryPassportId', f.batteryPassportId.value.trim());
        put('batteryChemistry', f.batteryChemistry.value.trim());
    }
    if (f.firstRegistrationDate.value) {
        // epoch days, as FIELDS.md specifies for date slots
        panel.firstRegistrationDate = Math.floor(
            new Date(f.firstRegistrationDate.value + 'T00:00:00Z').getTime() / 86_400_000);
    }
    for (const n of ['co2FootprintKgCO2e', 'recycledPlasticPct', 'recycledSteelPct', 'recycledAluminiumPct']) {
        if (f[n].value !== '') panel[n] = Number(f[n].value);
    }
    if (Object.keys(panel).length) intake.panel = panel;
    return intake;
}

// ---------------------------------------------------------------- submit

const submitted = document.getElementById('submitted');
const stepsEl = document.getElementById('steps');
const linksEl = document.getElementById('submitted-links');
const filedrop = document.getElementById('filedrop');

async function submitToCircuits(intake) {
    go.disabled = true;
    go.textContent = 'Proving…';
    try {
        const r = await fetch('/api/intake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(intake)
        });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error ?? `server said ${r.status}`);

        stepsEl.replaceChildren();
        for (const step of result.applied) {
            const li = document.createElement('li');
            li.className = 'ok';
            li.innerHTML = '<b>ok</b>';
            li.append(` ${step}`);
            stepsEl.append(li);
        }
        for (const ref of result.refused) {
            const li = document.createElement('li');
            li.className = 'refused';
            li.innerHTML = '<b>refused</b>';
            li.append(` ${ref.step} — ${ref.reason}`);
            stepsEl.append(li);
        }

        linksEl.replaceChildren();
        const view = document.createElement('a');
        view.className = 'primary';
        view.href = `../?v=${result.vinHex}`;
        view.textContent = 'View this passport';
        const proofs = document.createElement('a');
        proofs.className = 'ghost';
        proofs.href = '../proofs/';
        proofs.textContent = 'All proofs on the ledger';
        linksEl.append(view, proofs);

        filedrop.hidden = true;
        submitted.hidden = false;
        submitted.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        alert(`Could not submit: ${e.message}`);
    } finally {
        go.disabled = false;
        go.textContent = 'Register & prove';
    }
}

function offerFile(intake) {
    const text = JSON.stringify(intake, null, 2);
    document.getElementById('preview').textContent = text;
    submitted.hidden = true;
    filedrop.hidden = false;
    filedrop.scrollIntoView({ behavior: 'smooth', block: 'start' });

    document.getElementById('download').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = `intake-${intake.vin.slice(-6).toLowerCase()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    };
    document.getElementById('copy').onclick = (e) => {
        navigator.clipboard?.writeText(text).then(() => {
            e.target.textContent = 'Copied';
            setTimeout(() => { e.target.textContent = 'Copy JSON'; }, 1600);
        });
    };
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    const intake = buildIntake();
    if (serverMode) submitToCircuits(intake);
    else offerFile(intake);
});
