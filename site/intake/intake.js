/**
 * Intake console wiring for the hand-designed page.
 *
 * Two modes, decided by whether the app server answers /api/health:
 *
 *   server  REGISTER & PROVE posts to /api/intake, the compiled circuits run
 *           in-process, and the result section lists every step accepted or
 *           REFUSED, then links to the vehicle's verdicts.
 *   static  no server (GitHub Pages): the register button says so plainly and
 *           stays disabled; DOWNLOAD INTAKE FILE still produces the file for
 *           scripts/intake.mjs.
 *
 * The markup is the designer's specification: this script only fills selects,
 * toggles the states the design already draws, and rebuilds the result rows
 * in the same grammar. Refusals are rendered, never hidden.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { DEMO_VEHICLES } from '../assets/demo-vehicles.mjs';

const $ = (id) => document.getElementById(id);
const sections = [...document.querySelectorAll('section')];
const byTitle = (t) => sections.find((s) => s.querySelector('.stitle')?.textContent.trim().startsWith(t));

// ---------------------------------------------------------------- selects

const OPTIONS = {
    cat: [['M1', 'M1, passenger car'], ['M2', 'M2, minibus'], ['M3', 'M3, bus or coach'],
        ['N1', 'N1, van up to 3.5t'], ['N2', 'N2, truck up to 12t'], ['L', 'L, two or three wheeler']],
    fuel: [['bev', 'Battery electric (BEV)'], ['phev', 'Plug-in hybrid (PHEV)'], ['hev', 'Hybrid (HEV)'],
        ['petrol', 'Petrol'], ['diesel', 'Diesel'], ['h2', 'Hydrogen']],
    em: [['n/a', 'n/a (zero-emission)'], ['Euro 6e', 'Euro 6e'], ['Euro 6d', 'Euro 6d'],
        ['Euro 6', 'Euro 6'], ['Euro 5', 'Euro 5'], ['Euro 7', 'Euro 7']],
    wo: [['0', '0, none'], ['1', '1, category N, non-structural'],
        ['2', '2, category S, structural'], ['3', '3, category B, break']]
};
for (const [id, opts] of Object.entries(OPTIONS)) {
    const sel = $(id);
    sel.replaceChildren(...opts.map(([value, label]) => {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        return o;
    }));
}

// ---------------------------------------------------------------- mode

const statusCard = document.querySelector('nav ~ div div[style*="240px"]');
const registerBtn = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes('REGISTER'));
const downloadBtn = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.includes('DOWNLOAD'));
const circuitsNote = registerBtn.parentElement.querySelector('span');

let serverMode = false;
let apiBase = '';
(async () => {
    try {
        const { resolveApiBase } = await import('../assets/sources.mjs?v=3');
        const base = await resolveApiBase();
        serverMode = base != null;
        apiBase = base ?? '';
    } catch { serverMode = false; }
    const line = statusCard.querySelector('div');
    const dot = line.querySelector('span');
    if (serverMode && apiBase !== '') {
        line.innerHTML = line.innerHTML.replace('Local circuit server found',
            'Circuit server connected');
        statusCard.querySelector('.mono').textContent =
            'api.passport.vin · shared demo ledger, resets on restart';
    }
    if (!serverMode) {
        dot.style.background = '#8B95FF';
        line.append(''); // keep node shape
        line.childNodes[line.childNodes.length - 1].textContent = '';
        line.lastChild.textContent = '';
        line.innerHTML = line.innerHTML.replace('Local circuit server found',
            'No local circuit server');
        statusCard.querySelector('.mono').textContent =
            'read-only demo · run npm run app for the circuits';
        registerBtn.disabled = true;
        registerBtn.style.opacity = '.45';
        registerBtn.style.cursor = 'not-allowed';
        registerBtn.title = 'Needs the local circuit server: npm install && npm run app';
    }
})();

// ---------------------------------------------------------------- origin toggle

const typeSection = byTitle('PASSPORT TYPE');
const [newLabel, retroLabel] = typeSection.querySelectorAll('label');
let origin = 'new';

const paintOrigin = () => {
    for (const [label, mine] of [[newLabel, 'new'], [retroLabel, 'retrofit']]) {
        const active = origin === mine;
        const dot = label.querySelector('span span');
        const title = label.querySelector('b');
        label.style.border = active ? '1px solid #004AAD' : '1px solid rgba(0,74,173,.28)';
        label.style.background = active ? '#004AAD' : 'transparent';
        label.style.color = active ? '#EDE4D8' : '';
        title.style.color = active ? '' : '#004AAD';
        dot.style.border = active ? '1.5px solid #EDE4D8' : '1.5px solid rgba(0,74,173,.45)';
        dot.style.background = active ? '#EDE4D8' : 'transparent';
        dot.style.boxShadow = active ? 'inset 0 0 0 3px #004AAD' : 'none';
        for (const small of label.querySelectorAll('span')) {
            if (small === dot || small.contains(dot)) continue;
            small.style.color = active ? '' : '';
        }
    }
};
newLabel.addEventListener('click', () => { origin = 'new'; paintOrigin(); rebuildPicker(); });
retroLabel.addEventListener('click', () => { origin = 'retrofit'; paintOrigin(); rebuildPicker(); });

// ---------------------------------------------------------------- demo picker

const picker = $('dv');
const pickerLabel = document.querySelector('label[for="dv"]');
const expectBox = byTitle('DEMONSTRATION VEHICLE').querySelector('div[style*="240px"] p');
let selected = null;

function rebuildPicker() {
    const mine = DEMO_VEHICLES.map((v, i) => [v, i]).filter(([v]) => (v.origin ?? 'retrofit') === origin);
    pickerLabel.textContent = origin === 'new' ? 'Sample vehicle, new' : 'Sample vehicle, retrofit';
    picker.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'choose, or fill the form yourself';
    picker.append(none);
    const groups = {};
    const groupOf = (v) => {
        if (origin === 'retrofit') return 'Existing fleet';
        if (v.fuelType === 'bev') return 'Battery electric';
        if (['phev', 'hev'].includes(v.fuelType)) return 'Plug-in hybrid · hybrid';
        return 'Petrol · diesel · hydrogen';
    };
    for (const [v, i] of mine) {
        const g = groupOf(v);
        if (!groups[g]) {
            groups[g] = document.createElement('optgroup');
            groups[g].label = g;
            picker.append(groups[g]);
        }
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = v.name;
        groups[g].append(o);
    }
    selected = null;
    expectBox.textContent = origin === 'new'
        ? 'All accepted. A new vehicle proves its four claims by construction: keepers 0, and nothing on the record yet.'
        : 'Watch the odometer-rollback attempt get REFUSED in-circuit, and the written-off car decline the clean claims it cannot prove.';
}
rebuildPicker();

// ---------------------------------------------------------------- claims

const claimsSection = byTitle('CLAIMS TO PROVE');
const claimLabels = [...claimsSection.querySelectorAll(':scope > div > label')];
const mileageInput = claimLabels[3].querySelector('input');
const claimState = [true, true, true, true];

const paintClaim = (i) => {
    const label = claimLabels[i];
    const box = label.querySelector('span');
    const on = claimState[i];
    label.style.border = on ? '1px solid #004AAD' : '1px solid rgba(0,74,173,.28)';
    label.style.background = on ? 'rgba(0,74,173,.07)' : 'transparent';
    box.style.background = on ? '#004AAD' : 'transparent';
    box.style.border = on ? 'none' : '1px solid rgba(0,74,173,.4)';
    box.querySelector('svg').style.visibility = on ? 'visible' : 'hidden';
};
claimLabels.forEach((label, i) => {
    label.addEventListener('click', (e) => {
        if (e.target === mileageInput) return;
        claimState[i] = !claimState[i];
        paintClaim(i);
        paintCircuitCount();
    });
});

function paintCircuitCount() {
    const updates = selected?.updates?.length ?? 0;
    const n = 1 + 5 + updates + claimState.filter(Boolean).length;
    circuitsNote.textContent = `${n} circuits will run`;
}
paintCircuitCount();

// ---------------------------------------------------------------- fill

const evBlock = document.querySelector('div[style*="BEV / PHEV"], section div[style*="8B95FF"]');
const syncEv = () => {
    const ev = ['bev', 'phev'].includes($('fuel').value);
    evBlock.style.display = ev ? '' : 'none';
};
$('fuel').addEventListener('change', syncEv);

function fillForm(v) {
    $('vin').value = v.vin;
    $('reg').value = v.registrar;
    $('dl').value = v.label ?? '';
    $('cat').value = v.vehicleCategory ?? 'M1';
    $('fuel').value = v.fuelType ?? 'petrol';
    syncEv();
    $('em').value = v.emissionsClass ?? 'Euro 6e';
    $('bp').value = v.batteryPassportId ?? '';
    $('bc').value = v.batteryChemistry ?? '';
    $('km').value = v.fields.odometerKm;
    $('ac').value = v.fields.accidentCount;
    $('kp').value = v.fields.ownerCount;
    $('wo').value = String(v.fields.writeOffCategory);
    $('sv').value = v.fields.serviceCount;
    claimState[0] = v.prove.neverWrittenOff;
    claimState[1] = v.prove.noAccidents;
    claimState[2] = v.prove.oneKeeper;
    claimState[3] = v.prove.mileageUnder > 0;
    if (v.prove.mileageUnder > 0) mileageInput.value = v.prove.mileageUnder;
    claimState.forEach((_, i) => paintClaim(i));
    paintCircuitCount();
}

picker.addEventListener('change', () => {
    const v = DEMO_VEHICLES[Number(picker.value)];
    selected = v ?? null;
    if (v) {
        fillForm(v);
        expectBox.textContent = v.expect.replace(/^Expect: /, '');
    }
    paintCircuitCount();
});

// ---------------------------------------------------------------- intake

function buildIntake() {
    const intake = {
        vin: $('vin').value.trim().toUpperCase(),
        registrar: $('reg').value.trim(),
        fields: {
            odometerKm: Number($('km').value),
            accidentCount: Number($('ac').value),
            ownerCount: Number($('kp').value),
            writeOffCategory: Number($('wo').value),
            serviceCount: Number($('sv').value)
        },
        updates: selected?.updates ?? [],
        prove: {
            neverWrittenOff: claimState[0],
            noAccidents: claimState[1],
            oneKeeper: claimState[2],
            mileageUnder: claimState[3] ? Number(mileageInput.value) : 0
        }
    };
    if ($('dl').value.trim()) intake.label = $('dl').value.trim();

    const panel = { passportOrigin: origin };
    const put = (name, value) => {
        if (value !== '' && value !== undefined && value !== null) panel[name] = value;
    };
    put('vehicleCategory', $('cat').value);
    put('fuelType', $('fuel').value);
    put('emissionsClass', $('em').value);
    if (['bev', 'phev'].includes($('fuel').value)) {
        put('batteryPassportId', $('bp').value.trim());
        put('batteryChemistry', $('bc').value.trim());
    }
    // Fields the compact form does not show ride along from the demo record;
    // absent for manual entry, and absent slots are salted anyway.
    if (selected) {
        put('euTypeApprovalNumber', selected.euTypeApprovalNumber);
        if (selected.firstRegistrationDate) {
            panel.firstRegistrationDate = Math.floor(
                new Date(selected.firstRegistrationDate + 'T00:00:00Z').getTime() / 86_400_000);
        }
        for (const [k, val] of Object.entries(selected.env ?? {})) put(k, val);
    }
    intake.panel = panel;
    return intake;
}

// ---------------------------------------------------------------- result

const resultSection = sections.find((s) => s.querySelector('h3'));
resultSection.hidden = true;
const resultRowsHost = resultSection;
const resultCount = resultSection.querySelector('.mono');
const staticRows = [...resultSection.querySelectorAll(':scope > div')].slice(1, -1);
const rowTemplate = staticRows[0].cloneNode(true);
const refusedTemplate = staticRows[staticRows.length - 1].cloneNode(true);
const linksBar = resultSection.querySelector(':scope > div:last-child');

function resultRow(kind, name, text) {
    const row = (kind === 'refused' ? refusedTemplate : rowTemplate).cloneNode(true);
    const [status, circuit, desc] = row.querySelectorAll('span');
    status.textContent = kind === 'refused' ? 'REFUSED' : 'OK';
    circuit.textContent = name;
    desc.textContent = text;
    return row;
}

function renderResult(result) {
    for (const el of [...resultSection.querySelectorAll(':scope > div')].slice(1, -1)) el.remove();
    const rows = [];
    for (const step of result.applied) {
        const [name, ...rest] = String(step).split(': ');
        rows.push(resultRow('ok', name, rest.join(': ') || 'accepted'));
    }
    for (const r of result.refused) {
        rows.push(resultRow('refused', r.step, r.reason));
    }
    linksBar.before(...rows);
    resultCount.textContent =
        `${result.applied.length} accepted · ${result.refused.length} refused`;
    const view = linksBar.querySelector('a[href*="verify"]');
    view.href = `../verify/?v=${result.vinHex}`;
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- preprod

// The same intake, aimed at the real chain instead of this process. The
// toggle only offers itself when the server actually has preprod enabled and
// a run left today, so switching it on cannot fail on click.
const ppWrap = $('ppwrap');
const ppBox = $('ppbox');
const ppNote = $('ppnote');
const ppRun = $('pprun');
let preprod = false;
let ppReady = false;

const paintPreprod = () => {
    ppWrap.style.border = preprod ? '1px solid #004AAD' : '1px solid rgba(0,74,173,.28)';
    ppWrap.style.background = preprod ? 'rgba(0,74,173,.07)' : 'transparent';
    ppBox.style.background = preprod ? '#004AAD' : 'transparent';
    ppBox.style.color = preprod ? '#EDE4D8' : '';
    ppBox.style.border = preprod ? 'none' : '1px solid rgba(0,74,173,.4)';
    ppBox.querySelector('svg').style.visibility = preprod ? 'visible' : 'hidden';
    ppWrap.style.opacity = ppReady ? '' : '.55';
    ppWrap.style.cursor = ppReady ? 'pointer' : 'not-allowed';
    registerBtn.textContent = preprod ? 'REGISTER & PROVE ON PREPROD' : 'REGISTER & PROVE';
};
ppWrap.addEventListener('click', () => {
    if (!ppReady) return;
    preprod = !preprod;
    paintPreprod();
});

(async () => {
    let status = null;
    try {
        const { apiBase: resolveBase, getStatus } = await import('../assets/preprod-run.mjs?v=1');
        status = await getStatus(await resolveBase());
    } catch (e) {
        // Not answering is not the same as not offered: the engine restores a
        // large wallet before it can reply.
        status = e?.unreachable ? 'unreachable' : null;
    }

    ppReady = Boolean(status?.enabled && status?.ready && !status?.error && status.remaining > 0);
    if (ppReady) {
        ppNote.textContent = `${status.remaining} of ${status.capacity} preprod runs left today. Switch this on and the fields below become real transactions on the deployed contract, funded from our wallet, ending in a receipt only you can open. The VIN is replaced with a generated demo one, so a real vehicle is never claimed on a test chain.`;
    } else if (status?.enabled && !status?.ready) {
        ppNote.textContent = 'The preprod signing wallet is catching up to the chain tip. Until it is level, the circuits below still run here.';
    } else if (status?.enabled && status?.remaining <= 0) {
        ppNote.textContent = "Today's preprod runs are used; the count resets at 00:00 UTC. The circuits below still run here.";
    } else if (status === 'unreachable') {
        ppNote.textContent = 'The preprod engine is not answering right now: it blocks while it restores its wallet, and again while it generates a proof for someone else. Reload shortly to submit to the chain. The circuits below run here either way.';
    } else {
        ppNote.textContent = 'Preprod submission is not available from this server. The circuits below still run here, against an in-process ledger.';
    }
    paintPreprod();
})();

registerBtn.addEventListener('click', async () => {
    if (!serverMode) return;
    registerBtn.disabled = true;
    const was = registerBtn.textContent;
    registerBtn.textContent = preprod ? 'SUBMITTING…' : 'PROVING…';
    try {
        if (preprod) {
            const { startManual, followJob } = await import('../assets/preprod-run.mjs?v=1');
            const started = await startManual(apiBase, buildIntake());
            registerBtn.textContent = 'RUNNING ON PREPROD…';
            ppRun.scrollIntoView({ behavior: 'smooth', block: 'start' });
            await followJob(apiBase, started.jobId, ppRun);
        } else {
            const r = await fetch(`${apiBase}/api/intake`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildIntake())
            });
            const result = await r.json();
            if (!r.ok) throw new Error(result.error ?? `server said ${r.status}`);
            renderResult(result);
        }
    } catch (e) {
        alert(`Could not submit: ${e.message}`);
    } finally {
        registerBtn.disabled = false;
        registerBtn.textContent = was;
    }
});

downloadBtn.addEventListener('click', () => {
    const intake = buildIntake();
    const text = JSON.stringify(intake, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `intake-${(intake.vin || 'vehicle').slice(-6).toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
});
