# Decisions

Settled choices and the reasoning behind them. If something here looks wrong, the reasoning is
written down precisely so it can be argued with — but bring an argument, not a preference.

Dates are when the decision was taken.

---

## Settled

### D1 — Build on NIGHTGATE; do not fork it · 2026-08-21
ShieldVIN is a consumer application of `@odatano/nightgate`, in the same relation to it as NIGHTPASS.
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
The Digital Circularity Vehicle Passport is mandatory from 1 Sep 2032; the regulation entered into
force 13 Aug 2026 and applies from 1 Sep 2028.

**Why:** it converts ShieldVIN from a product nobody is obliged to buy into an implementation of an
obligation everyone in scope must meet. It also resolves a real structural problem in the earlier
positioning, where the paying customer (OEMs) was not the customer whose pain justified the product
(used-car buyers). Compliance collapses that gap.

**Do not overclaim.** ESPR (Reg 2024/1781) explicitly *excludes* vehicles; the battery regulation
reaches the battery, not the vehicle. 2026/1738 is the correct and only citation for a vehicle-level
passport obligation.

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
A single `shieldvin` repo, not the eight-repo split of the previous build.

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

---

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
| Q1 | Will ODATANO consider Merkle depth 5 (32 slots)? | Field panel headroom — see [FIELDS.md](FIELDS.md) | ODATANO maintainer |
| Q2 | Does a ≤16-slot custom panel need any `attestation-vault` change? | Phase 0 scope | Verify against installed package |
| Q3 | Which Buildathon wave to target? | Phase 0 sizing | Us |
| Q4 | Is SAP CAP acceptable as a permanent dependency? | Everything downstream | Us — inherited from D1, worth being deliberate about |
