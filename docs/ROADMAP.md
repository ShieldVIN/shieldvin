# Roadmap

Phases are ordered by dependency, not by date. Dates attach once
[Q3](DECISIONS.md#open) — which Buildathon wave to target — is settled.

For reference, the [Midnight Buildathon](https://midnight.network/hackathon/buildathon) runs three
separately-judged waves: Wave 1 builds 27 Aug – 16 Sep, Wave 2 to 17 Oct, Wave 3 to 16 Nov. The
format explicitly rewards iteration over one-shot polish, so an existing project is not penalised for
entering mid-stream.

---

## Phase 0 — A working vehicle passport

**Done when:** a vehicle passport can be registered on Midnight preprod, panel fields recorded as
private state, and threshold and integrity claims proved in-circuit without any value ever being
disclosed — reachable end-to-end from a browser.

The centrepiece is `contracts/vinpassport_passport.compact` (D16). Readings are witnesses; only
commitments reach the ledger. **Compile in WSL2** — Compact has no native Windows binary.

### Contract surface

| Circuit | Does | Private state |
|---|---|---|
| `registerPassport` | Anchor a vehicle's content root | — |
| `initialiseField` | Create a panel field and fix its integrity rule for good | The opening value |
| `recordField` | Write a new value, proving the caller knows the current one and that the change respects the field's rule | Both values |
| `proveFieldAtMost` | Prove a hidden value is at or below a bound | The value |
| `proveFieldAtLeast` | Prove a hidden value is at or above a bound | The value |

Role-scoped disclosure is Phase 1, in the service layer and NIGHTGATE's on-chain grants — not a
circuit here.

> **Rewritten 2026-08-31.** This list was the CAP-era plan and had drifted badly: it still called
> for scaffolding that [D20](DECISIONS.md#settled) removed, and left items unticked that shipped
> weeks ago. Ticks below are verified against the repository, not remembered.

- [x] Verify the [FIELDS.md](FIELDS.md) checklist against installed `@odatano/*` packages —
      24 assertions in `test/sdk-assumptions.mjs`, run by `npm test`
- [x] ~~CAP scaffold~~, ~~`nightgate-fetch-keys attestation-vault-32`~~, ~~`db/vehicle-schema.cds`~~
      — **dropped by [D20](DECISIONS.md#settled)**: no CAP application, and we deployed our own
      contract rather than registering a vault. Returns as Phase 1 service-layer work
- [x] `PROVABLE_FIELDS` registry, 32 slots per FIELDS.md — layout settled (26 used, 6 reserved);
      5 wired end to end, the rest documented but not yet exercised
- [x] Canonicalisation and anchoring path — `contentRoot` over the salted panel
- [x] Predicates end to end — `proveFieldAtMost` / `proveFieldAtLeast` land on preprod, and a
      claim that cannot hold is refused in-circuit and reported rather than hidden
- [x] The verification surface — `site/verify/`, QR to verdict, mobile, no login. (Built at
      `site/verify/`, not the planned `app/scan/`)
- [x] Seed data and a demo scenario — `npm run demo:export` regenerates `site/verify/` from the
      real compiled circuits, so the committed fixture cannot drift from the contract
- [x] Fee funding — **not** the planned treasury pool. [D24](DECISIONS.md#settled): one wallet,
      self-renewing DUST from registered NIGHT. Per-organisation sessions, and the attribution that
      comes with them, are Phase 1
- [ ] **Measure DUST cost** per anchor and per proof, batched versus unbatched, width 32 versus 16 —
      gates all pricing; see [BUILD-SCOPE.md](BUILD-SCOPE.md). **Not yet measured to a number worth
      pricing from**, and the reason is worth writing down so the next attempt does not repeat it:
      the wallet balance either side of a fee measures the dust *note* the balancer consumed, not
      the fee, and the change returns a stage later. Within one run that reads as a convincingly
      tight spread — under 2% across five stages — while two runs of the identical five-stage
      workload differ by 2.4x (2.89e17 vs 7.02e17 per stage) purely because the balancer picked
      differently sized notes. The whole-run delta is no better: DUST regenerates faster than an
      idle sample predicts, so one of those runs ended with *more* dust than it started with. The
      indexer's `fee` field is a placeholder (it reports 1). A run consumes notes totalling
      1.4e18-3.5e18 SPECKs and the true fee is somewhere below that; closing this needs the
      per-transaction spend decoded from the `DustSpendProcessed` ledger event, not a balance diff.
      Fees are charged per *transaction*, not per call, so batching two calls into one still halves
      the per-call cost whatever the absolute number turns out to be
- [ ] `contentSaltSeed` persistence **with a tested restore path** — a run seeds its salts per run
      and hands them to the holder in the receipt; there is no long-lived seed to restore yet

**Explicitly not in Phase 0:** billing, hardware, tiered disclosure UI, the console beyond a rough
form, Cardano, mainnet.

Sponsoring and cost measurement come **before** polished UI. If the unit economics do not work, the
UI is wasted effort.

One predicate working end to end demonstrates more than six half-wired ones. Start with the claims
a buyer actually asks — never written off, no reported accidents — because they are a single circuit
call each and they exercise the whole path: canonicalise, anchor, prove, submit, verify.

## Phase 1 — Tiered disclosure and a real audience

**Done when:** three distinct viewers see three genuinely different views of the same vehicle, and a
grant can elevate a viewer's tier on-chain.

- [ ] Tier redaction in `passport-service.ts`
- [ ] **Query guard** — reject `$filter`/`$orderby`/`$apply` that probe invisible columns. Redaction
      alone is bypassable; see [ARCHITECTURE.md](ARCHITECTURE.md)
- [ ] Disclosure grant issue and revoke
- [ ] Grantee identity binding — `sha256(did)`
- [ ] Consumer viewer — the buyer-facing scan
- [ ] Remaining predicates: accident count, recycled content, battery health
- [ ] Auth strategy and HTTP security middleware (NIGHTGATE provides neither)

## Phase 2 — Closing the trust gap

**Done when:** a sensor-signed reading can be distinguished from a self-declared one, and the
difference is visible to a verifier.

- [ ] Simulated secure element producing signed readings
- [ ] Provenance marking — self-declared vs sensor-attested
- [ ] Curve-agile signature spec (**not** Ed25519 — see [R1](DECISIONS.md#reversed))
- [ ] In-circuit verification design against ledger 9, documented and ready rather than deployed

This is the differentiator. It is deliberately last because Phases 0 and 1 must stand alone first —
and because in-circuit signature verification is not available on any public network today.

## Phase 3 — Interoperability

- [ ] Battery passport join via slots 17 and 29 — the regulation's interoperability clause, working
- [ ] NIGHTPASS composition demo
- [ ] EU DPP Registry enrolment path
- [ ] Dealer workflow — the [D7](DECISIONS.md#settled) beachhead

---

## Ordering principles

**Verify before building.** Every architectural claim in these docs comes from reading ODATANO's
public repositories, not from running them. Phase 0's first task is confirming the assumptions.

**One predicate working beats six wired up.** A single end-to-end proof exercises canonicalisation,
anchoring, proving, submission and verification. Breadth without that is scaffolding.

**Do not claim fraud prevention before Phase 2.** Phases 0–1 make fraud *attributable* and rollbacks
*detectable*. That is a real and defensible claim. Prevention is not, and overclaiming to a judge or
a partner is how credibility is lost.
