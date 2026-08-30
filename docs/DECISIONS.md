# Decisions

Settled choices and the reasoning behind them. If something here looks wrong, the reasoning is
written down precisely so it can be argued with — but bring an argument, not a preference.

Dates are when the decision was taken.

---

## Settled

### D1 — Build on NIGHTGATE; do not fork it · 2026-08-21
VINPassport is a consumer application of `@odatano/nightgate`, in the same relation to it as NIGHTPASS.
General needs go upstream as requests or PRs; vehicle-specific work stays here.

**Why:** NIGHTGATE already solves anchoring, ZK predicates, disclosure grants and wallet
infrastructure, with ~89% test coverage and a real release cadence. Rebuilding it would cost months
and produce something worse. Apache-2.0 means forking stays available if the relationship changes.

### D2 — Midnight, not Cardano · locked pre-2026-04, reaffirmed 2026-08-21
Privacy is the product, and Midnight's ZK model is the reason the disclosure tiers mean anything.

**Note:** ODATANO's centre of gravity is Cardano; NIGHTGATE is its Midnight arm. A DAYPASS-style
Cardano twin is a plausible *later* addition — the two share a frozen core so a dual-chain credential
is a known path — but it is not in scope and must not dilute Phase 0.

### D3 — Framed as Regulation (EU) 2026/1738 compliance infrastructure · 2026-08-21
The Digital Circularity Vehicle Passport (Article 46 of
**[Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj)**) is mandatory from
1 Sep 2032; the regulation entered into force 13 Aug 2026 and applies from 1 Sep 2028. Full
citations and primary sources: [REGULATION.md](REGULATION.md).

**Why:** it converts VINPassport from a product nobody is obliged to buy into an implementation of an
obligation everyone in scope must meet. It also resolves a real structural problem in the earlier
positioning, where the paying customer (OEMs) was not the customer whose pain justified the product
(used-car buyers). Compliance collapses that gap.

**Do not overclaim.** [ESPR (Reg 2024/1781)](https://eur-lex.europa.eu/eli/reg/2024/1781/oj)
explicitly *excludes* vehicles at Article 1(2); the
[battery regulation](https://eur-lex.europa.eu/eli/reg/2023/1542/oj) reaches the battery, not the
vehicle. 2026/1738 is the correct and only citation for a vehicle-level passport obligation — see
[REGULATION.md](REGULATION.md).

### D4 — No patent. Apache-2.0, fully open source · 2026-08-21
The patent track is dropped. No CIPC filing, no UK IPO filing.

**Why:** the novelty position became uncertain in absolute-novelty jurisdictions, and resolving that
uncertainty would have cost more than the protection was worth at this stage. Open-source also
matches the ODATANO stack and satisfies Catalyst's licensing requirement.

**Consequence:** the hardware attestation layer is defended by execution and partnership, not by IP.
The local patent drafts remain local — dropping the track is not a reason to publish claim language.

### D5 — Clients never need a crypto wallet; fees are fiat · locked 2026-04-02
No client of any kind is asked to hold NIGHT, DUST, or a wallet.

**Why:** blockchain complexity is an implementation detail, not something to push onto a dealer.
Previously a hand-wave; NIGHTGATE's **fee sponsoring** makes it a real mechanism — a caller with no
funds has their transaction paid for without the sponsor ever seeing a key, witness or preimage.

### D6 — Chip-free through Phase 1; hardware is Phase 2 · 2026-08-21
Phases 0 and 1 are pure document anchoring with no hardware root of trust.

**Why:** it removes the OEM dependency that previously blocked everything, making the product
demonstrable now instead of after a manufacturer partnership. The chips return in Phase 2 to close
the trust gap in [ARCHITECTURE.md](ARCHITECTURE.md) — which is a genuine differentiator, not
decoration, because NIGHTGATE explicitly does not attempt to fill it.

### D7 — Independent dealers are the beachhead, not OEMs · 2026-06-04, reaffirmed
Go-to-market leads with independent used-car dealers.

**Why:** external review found OEMs are hard to reach, slow, and not the party feeling the pain.
Dealers are reachable, carry liability today, and 2026/1738 pushes ELV and circularity data through
them well before the 2032 passport deadline.

### D8 — One repository · 2026-08-21
A single `vinpassport` repo, not the eight-repo split of the previous build.

**Why:** the seven-portal split was a significant part of why v1 stalled — cross-repo dependency
management consumed effort that should have gone into the product. Split later only when something
genuinely needs to ship on its own cadence.

### D9 — Preprod is the deployment target · 2026-08-21
Not mainnet. NIGHTGATE hard-gates mainnet submission off pending an unresolved node issue.

### D10 — Pin exact `@odatano/*` versions · 2026-08-21
Never a `^` or `~` range on any ODATANO package.

**Why:** 0.x with roughly weekly breaking changes. A whole attestation lane was removed at 0.16.0;
leaf salting at the same version broke every older client. Also keep a vendored copy of the exact
version in use — the org has a bus factor of one.

### D11 — Plain HTML/CSS/JS for every UI surface, console included · 2026-08-22
No SAPUI5, no React, no build-step framework for application UI.

**Why:** the product constraint is that this be simple enough for anyone — a used-car buyer with a
phone, a two-person independent dealer. NIGHTPASS uses SAPUI5 for operator apps and plain HTML for
public ones; we go plain throughout, because our operator *is* a small dealer rather than an SAP
shop. Also avoids a framework learning curve on a small team.

### D12 — Custodial per-organisation wallets, built to accept external signers · 2026-08-22
VINPassport custodies one wallet session per organisation. `srv/lib/sponsor.ts` puts the signing source
behind an interface so self-custody drops in later without a rewrite.

**Why:** attribution is the entire value of Phases 0–1. If VINPassport signed everything, VINPassport
would be asserting facts it cannot verify — transferring liability in exactly the wrong direction.
Per-organisation wallets keep the dealer's name on the record while never showing them a key.

**Claim honestly:** custodial attestation is tamper-evident and attributable, **not** non-repudiable.
Pair every attestation with an authenticated intent record. See [BUILD-SCOPE.md](BUILD-SCOPE.md).

### D13 — Every transaction sponsored from a VINPassport treasury pool · 2026-08-22, amended 2026-08-23
No customer ever holds DUST or NIGHT. A **pool** of treasury sponsor sessions pays all fees.

**Amendment (2026-08-23):** this originally said "a designated treasury session", singular. That was
wrong. Since NIGHTGATE 0.17.2 `NIGHTGATE_FEE_SPONSOR_SESSION` is a lease pool, because *"a dust
wallet carries ONE spend in flight, so sponsoring throughput scales with the NUMBER of sponsor
wallets."* Peak concurrent anchoring is bounded by wallet count, each needing its own registered
NIGHT UTxO. **Treasury sizing is a count of wallets, not a balance.**

**Consequence:** we pay per transaction, so per-organisation rate limiting is a cost control, not
just an abuse control. Treasury NIGHT is free on preprod and a real operating cost on mainnet.
Batching (up to 8 calls per transaction, one fee) is the primary lever on that cost.

### D15 — Target `attestation-vault-32`: 32 slots, depth 5 · 2026-08-23
The vehicle document family uses the 32-slot vault lineage introduced in NIGHTGATE 0.19.0, with 26
fields in use and 6 reserved.

**Why:** cross-root proofs relate documents of the same width only, so *"a document family picks a
width and keeps it."* With nothing yet anchored the choice is free; after launch it is a migration
onto a different contract lineage. The previous 16-slot panel was full on day one with twelve
credible fields cut, several plausibly mandatory once 2026/1738 applies in 2028.

**Costs accepted:** the lineage is new (shipped 2026-08-22), prover keys scale linearly so proving is
heavier, and the keys need a separate `npx nightgate-fetch-keys attestation-vault-32` step because
they are not packed into npm. Width 32 versus 16 proving cost is measured in Phase 0.

**Ordering constraint:** reserved slots are typed by position — four numeric before the strings, two
string after — because numerics must precede all strings and reordering changes every root.

### D14 — All payments fiat; billing gates the action, not the chain · 2026-08-22
One-off, subscription or annual, in fiat. No crypto payment path. Entitlement is checked in `srv/`
before NIGHTGATE is called; the contract never learns an invoice exists.

**Deferred:** no billing in Phase 0 and no provider chosen. Plans cannot be priced until DUST cost
per anchor and per proof is measured — which is why that measurement is a Phase 0 task.

### D16 — VINPassport writes its own Compact contract; NIGHTGATE deploys and calls it · 2026-08-23
The vehicle passport logic lives in a VINPassport Compact contract with genuine private-state
management. NIGHTGATE registers it via `cds.requires.nightgate.contracts.<ref>` and supplies
deployment, invocation and fee sponsoring.

**Why:** the earlier plan leaned entirely on NIGHTGATE's precompiled `attestation-vault-32`, and
"no Compact toolchain required" was recorded as a benefit. That is the wrong shape for this project.
The passport's distinguishing logic — readings held as witnesses, monotonicity proven in-circuit,
values never disclosed — is ours, and it belongs in a contract we wrote and can reason about.

**Consequence:** Compact is now on the critical path. It has no native Windows binary, and on this
host `compact` resolves to the Windows NTFS utility — **always compile in WSL2**. Toolchain verified
2026-08-23: CLI 0.5.2, compiler 0.31.1 (language 0.23, ledger 8), smoke compile passing.

**Attribution:** VINPassport is a consumer application built *on* NIGHTGATE, in the same relation
[NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) is. That dependency is stated plainly in the
README rather than left to be discovered.

### D17 — vitest for contract tests, `node --test` for the app layer · 2026-08-25
Two test runners in one repository, split by what they test. Contract tests run on **vitest**;
application unit tests, when they exist, run on **`node --test` + `tsx`**.

**Why:** D-era BUILD-SCOPE recorded `node --test` "deliberately not vitest", to match ODATANO. That
reasoning still holds for the CAP service layer, which is where we integrate most closely with their
tooling and where a contributor moving between the two codebases should find the same conventions.

It does not hold for contract tests. Those exercise compiled Compact circuits through
`@midnight-ntwrk/compact-runtime`, which is a Midnight concern rather than a CAP one, and Midnight's
own ecosystem tests contracts with vitest — `example-bboard` does, and the `midnight-cq` tooling
assumes it. A reviewer reading our contract tests is a Midnight reviewer, and they should find the
shape they expect.

**Cost, stated plainly:** two runners in one repo is worse than one, and `npm test` has to chain
them. That is accepted in exchange for each half matching the convention of the ecosystem it belongs
to.

**Also pinned here:** `@midnight-ntwrk/compact-runtime` at **exactly 0.16.0**, because it must equal
the `runtime-version` the compiler stamps into `contract-info.json`. A caret range would allow a
silent mismatch between the runtime the tests use and the one the contract was built for.

### D18 — One field-generic contract; the integrity rule lives on the ledger · 2026-08-26
`vinpassport` no longer has odometer-specific circuits. It holds a commitment per
`(vehicle, field)` slot, and `initialiseField` fixes that field's **integrity rule** at creation:
`neverFalls` or `neverRises`.

**Why generic:** a passport is 32 fields. Four odometer circuits plus four near-identical write-off
circuits plus four for accidents is not a design, it is copy-paste — and it would have made the
contract the weakest thing in the repository rather than the strongest.

**Why the rule is stored rather than passed:** if the rule were a call argument, a caller would
simply pass the one that suits them. On the ledger and written once, it cannot be renegotiated, and
recreating a field to change it is refused.

**Why two directions when the panel only uses one:** every field the panel carries today may never
fall — mileage, accidents, keepers, services, write-off category. A rule that could only ever point
one way would not be a rule: `initialiseField` would not need the argument and nothing would be
fixed at creation. Keeping both directions means a field that only declines can be added as a data
change rather than a contract change, and the tests prove that support is real rather than
aspirational.

**Consequence:** `proveFieldAtMost` with a bound of zero expresses "never written off" and "never
had a reported accident"; the odometer is simply field `odometerKm` under `neverFalls`, one field
among the panel rather than the subject of the contract. Both guards mutation-checked: removing
either fails exactly the tests it exists for and nothing else.

**Scope note:** this is the VEHICLE's record. An EV's battery is a separate regime with its own
passport, and [NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) covers that ground. The panel
carries a reference to a battery passport and does not restate its claims — see the open question on
slot 17 in [FIELDS.md](FIELDS.md).

**Also fixed here:** `.gitignore` excluded prover keys with `managed/**/keys/`, which contains a
slash and so anchors to the repository root — it never matched the real path under `contracts/`.
14 MB of keys were one `git add -A` away from being committed. Now `**/managed/**/keys/`.

---

### D19 — A proven claim is recorded on the ledger; the value behind it is not · 2026-08-27

`proveFieldAtMost` and `proveFieldAtLeast` write a `Claim` to a `claims` ledger on success. The
claim carries the slot, the VIN hash, the field key, the bound, the direction, and the commitment
the proof opened. It never carries the value.

**Why:** as first written, both circuits only asserted and returned `[]`. The transaction's success
was the proof — but nothing on the ledger recorded it, so nothing indexed a proof by vehicle. A
scan-to-verdict page had no state to read and could only report that a passport exists. The
alternatives were verification by transaction hash (which needs the hashes handed to the verifier,
or a crawl of every transaction to the contract) and shipping only what the ledger already held
(which is not a verdict). Recording the claim makes the answer an O(1) read.

**Why the commitment is part of the claim:** a claim recorded permanently would otherwise become a
lie. Prove "at most 300 000 km", then record 310 000 — the old claim still sits on the ledger.
Binding the claim to the commitment it was proven against means a verifier comparing it with the
current `fieldCommitment` for the same slot sees a superseded claim for what it is, without being
told. The claim key includes the commitment too, so re-proving after an update writes a new claim
rather than overwriting the old one.

**What this discloses, deliberately:** the field key. Before this, only `slot = hash(domain, vinHash,
fieldKey)` was public, so an observer could not tell the odometer's slot from the write-off
category's. A claim names its field, because a verdict a verifier cannot read is not a verdict.
Fields nobody has claimed about stay unnamed. The VIN hash was already public — `passports` is
keyed by it. **The value remains private in every case**, and the test suite pins both halves: one
test asserts the field is published, the next asserts the reading is not.

**Why the claim carries `slot` and not just the hashes to derive it:** the scan page is plain
HTML/CSS/JS with no build step ([D11](#settled)), so it cannot run `persistentHash` to compute a
claim key or a slot. Everything it needs to render a verdict — and to check the claim is current
— has to be readable straight off the claim. That is a real constraint on the struct's shape, not
redundancy.

**Cost:** one map insert per proof. Enumerating `claims` to answer "what has this vehicle proven?"
is linear, which is fine at demo scale and is the thing to revisit when it is not — an off-chain
index, or key derivation once the page can run `compact-runtime`.

**Mutation-checked.** Removing the claim write from `proveFieldAtMost` fails 9 tests and no others;
pointing `proveFieldAtLeast` at the `atMost` domain tag fails exactly the one test that separates a
ceiling from a floor.

### D20 — `@odatano/nightgate-tx` with sponsored fees; no CAP for Wave 1 · 2026-08-27

VINPassport deploys and calls `vinpassport` through **`@odatano/nightgate-tx` 0.4.0**, with
ODATANO's hosted NIGHTGATE sponsoring the preprod fees. No SAP CAP application, no Postgres, no
proof server, and no wallet of our own to fund. [D16](#settled) is **deferred, not reversed**.

**Corrected 2026-08-27, same day.** This decision was first recorded on the premise that using
NIGHTGATE meant standing up SAP CAP, because `@odatano/nightgate` declares
`peerDependencies: { '@sap/cds': '>=10 <11' }`. That is the *CAP plugin*. There is a second package,
`@odatano/nightgate-tx`, described as *"drive a hosted NIGHTGATE and build transactions locally with
your own key"* — no CAP, no database, wasm proving in process. Our own `nightgate-demo` clone
already depended on it. The original plan (midnight-js plus a faucet-funded wallet) was more work
than this for a weaker result, and is kept only as the fallback below.

**Why:** Wave 1 closes **2 September 2026**. This path needs no infrastructure, and sponsored
deploys shipped in NIGHTGATE 0.21.0 on 25 August, so the deploy is ours to run rather than something
we wait on ODATANO to do for us. Agent grants never used to include deploys; grant `shieldvin-w1`
carries `allowDeploy: true`, `maxDeploys: 2`, 200 sponsored jobs per UTC day.

**The privacy model is untouched, and this is the reason the dependency is acceptable.** Every
transaction is built, proven and **signed locally**; NIGHTGATE receives transaction bytes with the
fee unpaid, pays, and submits. It never holds a witness. Calls into our contract *cannot* run on
their server — `recordField` and `proveField*` need witnesses the server has no material for.
[D13](#settled) holds: no end user touches a wallet, and deployment is a one-off admin act.

**Fallback, at the cost of one step:** because the transaction is signed before it leaves us, a
sponsor outage is survivable by submitting it ourselves from a funded wallet. That is a change to
the final step, not a rebuild — which is what makes the dependency on `api.nightgate.dev`
tolerable after the 503 incident on 25 August.

**Attribution consequence.** Wave 1 genuinely builds on ODATANO in three ways: the field panel's
derivation (`dpp-sdk`), local transaction building (`nightgate-tx`), and sponsored fees. The README
states all three, including that NIGHTGATE pays and submits but never sees a witness. Under-claiming
this would fail `w1-audit-fork`, which exists to state the relationship before a judge finds it.
What we must *not* claim is NIGHTGATE's CAP service, OData layer, `attestation-vault` contract, or
disclosure grants — none of which are in this submission.

**Watch:** `maxDeploys: 2` means one redeploy in reserve, and `registerPassport` is insert-once per
`vinHash`, so a redeploy starts from an empty ledger. Do not spend a deploy on a contract that is
not final.

### D21 — A dependency-free app server makes the frontend functional · 2026-08-27

`npm run app` starts one Node server (no packages beyond Node itself) that serves the three
surfaces — verification, intake console, proof explorer — and runs the compiled circuits
in-process. Submitting the console form registers, records and proves for real; refusals are
returned and rendered, not hidden. Served statically (GitHub Pages), the same pages fall back to
the committed demo export, and the console produces an intake file instead — each mode labels
itself.

**Why:** "fill in the fields and see the proofs" must actually work for anyone who clones the
repo, and the alternatives failed that test. Running `compact-runtime` in the browser needs a
bundler (against D11's no-build-step rule and unproven under deadline); a file-download-and-run-a-
script flow is not a frontend. One in-process server is the smallest thing that is honestly
functional — and it mirrors the real architecture, where an operator's backend runs proving and
buyers verify statically.

**The boundary that matters:** values submitted through the console exist only inside the server
process, exactly as they would inside a wallet. What `/api/ledger` exports is commitments and
claims — the same shape the chain would show, produced by the same export code as the committed
demo state (`scripts/lib/scenario.mjs`, shared so the two cannot drift).

### D22 — The project is VINPassport; ShieldVIN is retired · 2026-08-27

The name ShieldVIN collided with an existing registered company, found before any
mainnet deploy and before the Wave 1 submission. The project, the GitHub organisation
(`VINPassport`), the repository (`VINPassport/VINPassport`), the npm scope
(`@vinpassport/passport`), and the contract (`contracts/vinpassport`) are all renamed.

Because nothing had been deployed to preprod, the rename reached the protocol layer at
zero cost: every domain-separation tag moved from `shieldvin:*` to `vinpassport:*`
(`vinpassport:field:v1`, `vinpassport:claim:atmost:v1`, `vinpassport:claim:atleast:v1`,
`vinpassport:leaf:v0`, `vinpassport:leafsalt:v0`), which changes the circuits and
therefore the eventual contract address. (The address itself is minted fresh with
each built deploy transaction; only the one that is submitted fixes it, and it is
recorded in `deploy/preprod.json` at that moment.) After a deploy this would have meant a second
grant slot and a migration; on 2026-08-27 it meant a recompile and a green test run.

One identifier deliberately keeps the old name: ODATANO's agent grant is `shieldvin-w1`.
That string is their record key, not our brand, and renaming it is not ours to do.

### D23 — Wave 1 contract limits, stated rather than hidden · 2026-08-30

An adversarial security review of the deployed contract confirmed the commitment-opening pattern,
the ledger-pinned integrity rules and the domain separation are all correct. It also surfaced four
properties of the Wave 1 contract that we record here plainly, because a limitation a judge can
disprove costs more than one we name ourselves. The contract is deployed and immutable, so these are
disclosures for Wave 1 and fixes for Wave 2, not pre-submission patches.

1. **No access control on `registerPassport` or `initialiseField`.** Both are insert-once and
   neither checks the caller. Because `vinHash = blake2b(VIN)` is publicly derivable, any party can
   pre-register a VIN (fixing its `registrarId` and `contentRoot`) or seize a still-uninitialised
   field of a registered passport (fixing its value, salt and monotonicity rule) — permanently, with
   no recovery circuit. This is a *liveness and integrity* gap, distinct from the already-documented
   *attribution* gap that the registrar string is unauthenticated. Wave 2 gates both circuits on a
   registrar identity derived in-circuit from a witness secret and compared to pinned ledger state
   (never `ownPublicKey()`).

2. **The VIN namespace is first-come and unrecoverable in Wave 1.** A corollary of (1): the first
   registration of a VIN is also the only one, forever. `BATCH-INTAKE.md` presents insert-once as a
   safety property, which it is — but the namespace has no allowlist yet, so first-come is also
   first-and-only. Wave 2: an allowlist of registrar identities pinned at deploy.

3. **Field commitments are not bound in-circuit to the anchored `contentRoot`.** No circuit reads
   the `contentRoot` value; proofs bind a value to its `fieldCommitment`, not to the anchored
   document. `ARCHITECTURE.md`'s trust-gap section now states this precisely. Wave 2 anchors field
   commitments as leaves of the same root, or proves inclusion.

4. **`vinHash` is public and its per-slot updates are an observable side channel.** `vinHash` is a
   cleartext key on the ledger and `slotOf(vinHash, fieldKey)` is reproducible off-chain from
   published constants, so an observer holding a VIN can enumerate its slots and see *which* field
   changed on each `recordField` — an event disclosure without a value disclosure. Since a same-value
   rewrite is permitted, scheduled cover-traffic rewrites decorrelate a write from an event; this is
   noted for Wave 2, not implemented in Wave 1. This corrects the earlier assumption (old D19 phrasing
   and a test comment) that an observer does not know the VIN — the interested party always does.

The demo-data generator's salts are a separate, off-contract item tracked in the open-issues list.

## Reversed

Recorded so they are not accidentally reinstated.

### R1 — Ed25519 for sensor signatures · REVERSED 2026-08-21
Previously "Ed25519 is correct for SE chips." **No longer safe.**

Compact has no Ed25519 verification in any version — confirmed at source across six release tags.
Nor is there any in-circuit signature verification at all on mainnet (0.31.x / ledger 8).
`jubjubSchnorrVerify` exists only on the ledger-9 RC line, undocumented and publicly deployed
nowhere. **Spec Phase 2 hardware curve-agile**; Schnorr-over-Jubjub is the likely landing point.

### R2 — Seven-portal architecture · REVERSED 2026-08-21
Superseded by D8.

### R3 — OEM-first go-to-market · REVERSED 2026-06-04
Superseded by D7.

### R4 — Patent as IP moat · REVERSED 2026-08-21
Superseded by D4.

---

## Open

| # | Question | Blocks | Owner |
|---|---|---|---|
| Q3 | Which Buildathon wave to target? | Phase 0 sizing | Us |
| Q4 | Is SAP CAP acceptable as a permanent dependency? | Everything downstream | Us — inherited from D1, worth being deliberate about |
| Q5 | Proving cost at width 32 versus 16 | Whether D15 holds under real cost | Phase 0 measurement |
| Q6 | Fiat provider — merchant of record or direct? | Billing build | Deferred to Phase 1, turns on EU VAT |

### Resolved

**Q1 — "Will ODATANO consider Merkle depth 5 (32 slots)?" — YES, shipped 2026-08-22.**
NIGHTGATE 0.19.0 introduced `attestation-vault-32`, and `@odatano/dpp-sdk@0.2.0` exposes
`VAULT_SLOT_WIDTHS = [8, 16, 32]`. Asked on the 21st, answered by a release on the 22nd — not on our
account. See [D15](#settled).

**Q2 — "Does a custom panel need an `attestation-vault` change?" — reframed, not needed.**
A registered contract now carries a `slotWidth` and the surface sizes itself from it. We select a
lineage by name (`compiledArtifactRef: 'attestation-vault-32'`) rather than modifying a contract.
