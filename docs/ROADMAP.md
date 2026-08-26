# Roadmap

Phases are ordered by dependency, not by date. Dates attach once
[Q3](DECISIONS.md#open) — which Buildathon wave to target — is settled.

For reference, the [Midnight Buildathon](https://midnight.network/hackathon/buildathon) runs three
separately-judged waves: Wave 1 builds 27 Aug – 16 Sep, Wave 2 to 17 Oct, Wave 3 to 16 Nov. The
format explicitly rewards iteration over one-shot polish, so an existing project is not penalised for
entering mid-stream.

---

## Phase 0 — A working vehicle passport

**Done when:** a vehicle passport can be registered on Midnight preprod, an odometer reading recorded
as private state, and monotonicity and threshold claims proved in-circuit without the reading ever
being disclosed — reachable end-to-end from a browser.

The centrepiece is `contracts/shieldvin_passport.compact` (D16). Readings are witnesses; only
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

- [ ] Verify the [FIELDS.md](FIELDS.md) checklist against installed `@odatano/*` packages — **first
      task, gates everything else**
- [ ] CAP scaffold with `@odatano/nightgate` 0.19.0 pinned, registering `attestation-vault-32`
- [ ] `npx nightgate-fetch-keys attestation-vault-32` — keys are not packed in npm
- [ ] `db/vehicle-schema.cds` — vehicle domain model
- [ ] `PROVABLE_FIELDS` registry, 32 slots per FIELDS.md (26 used, 6 reserved)
- [ ] Canonicalisation and anchoring path
- [ ] **Treasury pool and sponsor wiring** — at least two sponsor wallets with registered NIGHT
      UTxOs, to exercise the lease pool rather than a single-wallet happy path; confirm attribution
      lands on the organisation rather than on us
- [ ] **Measure DUST cost** per anchor and per proof, batched versus unbatched, width 32 versus 16 —
      gates all pricing; see [BUILD-SCOPE.md](BUILD-SCOPE.md)
- [ ] Odometer monotonicity predicate, end to end
- [ ] `app/scan` — QR to verdict, mobile, no login
- [ ] `contentSaltSeed` persistence **with a tested restore path**
- [ ] Seed data and a demo scenario

**Explicitly not in Phase 0:** billing, hardware, tiered disclosure UI, the console beyond a rough
form, Cardano, mainnet.

Sponsoring and cost measurement come **before** polished UI. If the unit economics do not work, the
UI is wasted effort.

The odometer proof is the whole point of this phase. One predicate working end to end demonstrates
more than six half-wired ones.

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
