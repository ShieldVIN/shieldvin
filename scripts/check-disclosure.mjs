/**
 * Pre-commit guard: keep findings, weaknesses and open issues out of the repo.
 *
 * Standing project rule: they are tracked locally (SECURITY-NOTES.local.md,
 * gitignored) and never appear in a commit message, a code comment, or any
 * committed file. This runs on every commit so the rule does not depend on
 * anyone remembering it.
 *
 * What it inspects:
 *   - the added lines of the staged diff (not the whole file: existing text is
 *     someone else's decision, and re-flagging it on every commit is noise)
 *   - the commit message, when run as a commit-msg hook
 *
 * Usage:
 *   node scripts/check-disclosure.mjs --staged          # pre-commit
 *   node scripts/check-disclosure.mjs --msg <file>      # commit-msg
 *   node scripts/check-disclosure.mjs --range A..B      # audit a range
 *   node scripts/check-disclosure.mjs --install         # install both hooks
 *
 * Deliberately blunt. A false positive costs a reword; a false negative costs
 * something that cannot be taken back off the internet.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Phrases that describe a weakness rather than a design. */
const PATTERNS = [
    [/\bbypassab\w*|\bbypass(ed|ing|es)?\b/i, 'describes something being bypassed'],
    [/\bunauthenticated\b|\bno auth\b|\bwithout auth\b/i, 'names a missing authentication control'],
    [/\battacker\b|\badversar(y|ial)\b|\bmalicious\b/i, 'describes an attacker'],
    [/\bexploit(ed|able|ing)?\b|\bvulnerab\w+|\bCVE-\d/i, 'names an exploit or vulnerability'],
    [/\bspoof(ed|able|ing)?\b|\bforge(d|able)?\b|\btamper(ed|able)\b/i, 'describes forging or spoofing'],
    [/\bcurl loop\b|\bCORS only\b|\bonly stops browsers\b/i, 'explains how a control is evaded'],
    [/\bdenial[- ]of[- ]service\b|\bDoS\b/, 'names a denial-of-service'],
    [/\b(sql|command|html|script)\s+injection\b/i, 'names an injection class'],
    [/\brace condition\b|\bTOCTOU\b/i, 'names a race condition'],
    [/\bprivilege escalation\b|\bauth(z|orisation|orization) bypass\b/i, 'names an escalation'],
    [/\bcorrupt each other\b|\boverwrit(e|ing) each other\b/i, 'describes concurrent corruption'],
    [/\bspend the day'?s\b|\bexhaust the\b|\bburn the (daily )?cap\b/i, 'describes resource exhaustion'],
    [/\bfalse[- ]confirm\w*|\bdouble[- ]land\w*/i, 'describes a confirmation weakness'],
    [/\bsecond instance\b.*\bsame\b|\btwo processes\b.*\bone (wallet|state)\b/i, 'describes a concurrency hazard'],
    [/\bstranded\b.*\b(dust|fund|note)|\bwedged?\b/i, 'describes a stuck-funds state'],
    [/\bknown (bug|issue|weakness|limitation)\b|\bopen issue\b/i, 'points at a tracked issue'],
    [/\bnot fixed\b|\bstill (vulnerable|broken|exposed)\b|\bworkaround for\b/i, 'flags an unfixed problem'],
];

/**
 * Phrasings that trip the patterns while asserting the OPPOSITE - a guarantee
 * rather than a weakness. Checked first so a positive claim is not blocked.
 */
const ALLOW = [
    /\bleaks? nothing\b/i,
    /\bleaked no\b/i,
    /\bnever leaves?\b/i,
    /\bcannot collide\b/i,
    /\bnever sees? a witness\b/i,
    /\bno (private )?value (ever )?leaves?\b/i,
    /check-disclosure/i,          // this file describing itself
    /SECURITY-NOTES\.local/i,     // pointing AT the local file is fine
];

const scan = (text, where) => {
    const hits = [];
    text.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        if (ALLOW.some((a) => a.test(line))) return;
        for (const [re, why] of PATTERNS) {
            if (re.test(line)) { hits.push({ where, line: i + 1, why, text: line.trim().slice(0, 120) }); break; }
        }
    });
    return hits;
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function stagedAdditions() {
    const diff = git('diff', '--cached', '--unified=0', '--no-color');
    const out = [];
    let file = '?';
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
        if (line.startsWith('+') && !line.startsWith('+++')) out.push({ file, text: line.slice(1) });
    }
    return out;
}

function report(hits) {
    console.error('\n  COMMIT BLOCKED - security detail must not enter this repository.\n');
    for (const h of hits.slice(0, 20)) {
        console.error(`   ${h.where}${h.line ? ':' + h.line : ''}`);
        console.error(`     ${h.why}`);
        console.error(`     > ${h.text}\n`);
    }
    if (hits.length > 20) console.error(`   ...and ${hits.length - 20} more\n`);
    console.error('  Findings, weaknesses and open issues go in SECURITY-NOTES.local.md (gitignored).');
    console.error('  In the repo, state the RULE, not the weakness it guards against.\n');
    console.error('  Deliberate exception, only with the owner\'s say-so: SKIP_DISCLOSURE_CHECK=1 git commit ...\n');
}

const args = process.argv.slice(2);
const mode = args[0] ?? '--staged';

if (mode === '--install') {
    // Runs from package.json's `prepare`, so it must be silent and successful
    // wherever there is no repository to hook - a tarball, a vendored copy, a
    // CI checkout without .git. Nothing to install is a normal outcome, not a
    // reason to fail someone's `npm install`.
    if (!existsSync(join(ROOT, '.git'))) {
        console.log('disclosure check: no .git here, nothing to install');
        process.exit(0);
    }
    const hooks = join(ROOT, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const pre = '#!/bin/sh\n[ "$SKIP_DISCLOSURE_CHECK" = "1" ] && exit 0\nexec node scripts/check-disclosure.mjs --staged\n';
    const msg = '#!/bin/sh\n[ "$SKIP_DISCLOSURE_CHECK" = "1" ] && exit 0\nexec node scripts/check-disclosure.mjs --msg "$1"\n';
    writeFileSync(join(hooks, 'pre-commit'), pre); chmodSync(join(hooks, 'pre-commit'), 0o755);
    writeFileSync(join(hooks, 'commit-msg'), msg); chmodSync(join(hooks, 'commit-msg'), 0o755);
    console.log('installed .git/hooks/pre-commit and .git/hooks/commit-msg');
    process.exit(0);
}

if (process.env.SKIP_DISCLOSURE_CHECK === '1') process.exit(0);

let hits = [];
if (mode === '--msg') {
    const f = args[1];
    if (!f || !existsSync(f)) { console.error('--msg needs a message file'); process.exit(2); }
    const body = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
    hits = scan(body, 'commit message');
} else if (mode === '--range') {
    const range = args[1];
    if (!range) { console.error('--range needs A..B'); process.exit(2); }
    for (const sha of git('rev-list', range).split(/\r?\n/).filter(Boolean)) {
        hits.push(...scan(git('log', '-1', '--format=%B', sha), `commit ${sha.slice(0, 8)}`));
    }
} else {
    for (const { file, text } of stagedAdditions()) {
        // The local notes file is where this material belongs, and this file
        // has to spell the vocabulary out to look for it. Everything else is
        // fair game.
        if (/\.local\.md$/.test(file)) continue;
        if (/check-disclosure\.mjs$/.test(file)) continue;
        hits.push(...scan(text, file).map((h) => ({ ...h, line: null })));
    }
}

if (hits.length) { report(hits); process.exit(1); }
console.log(`disclosure check: clean (${mode})`);
