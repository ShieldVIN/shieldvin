# Provable field registry

**Target: `attestation-vault-32` — 32 slots, depth 5.** 26 fields in use, 6 reserved.

> This document was rewritten on 2026-08-23. NIGHTGATE 0.19.0 (22 Aug) introduced a 32-slot vault
> lineage, lifting what had been this project's tightest constraint. The previous revision described
> a 16-slot panel filled to capacity.

## Slot widths

`@odatano/dpp-sdk@0.2.0` exposes `VAULT_SLOT_WIDTHS = [8, 16, 32]`, with `MERKLE_DEPTH = 4`
documented as *"DEFAULT tree depth (16-slot panel), **not a limit**"*. Width maps to depth via
`depthForWidth()` — 16 → 4, 32 → 5.

NIGHTGATE's own note on why the menu stops at 32:

> Widths were measured before the choice: prover keys scale linearly and wasm proving hits its
> memory ceiling at 64, so the menu is 16 and 32.

**Width is effectively permanent.** Cross-root proofs relate documents of the same width only, so a
document family picks a width and keeps it. Changing later means re-anchoring every passport onto a
different contract lineage. We choose 32 now, while we have nothing anchored and the choice is free.

## Two rules that constrain the layout

**Numerics must precede all strings.** `provableFieldKind()` returns `'numeric' | 'string'`, and the
registry ordering is frozen shared vocabulary.

**Reserved slots must be typed by position.** A slot reserved *after* the strings can only ever hold
a string. Adding a numeric later would mean reordering — which changes every root. So the reserve is
split: four numeric slots before the strings, two string slots after.

**Overflow is loud, not silent.** `padToWidth` throws rather than dropping the tail, *"a registry
that outgrew its width would otherwise silently stop anchoring its last fields."*

---

## The panel

Numerics scale ×1000 into Uint64 (`VALUE_SCALE = 1000`). Strings commit to the blake2b-256 digest of
the exact string. Public label is `fieldKeyHex(name)` = blake2b-256 of the field name.

### Numeric — slots 0–17

| # | Field | Serves | Note |
|---|---|---|---|
| 0 | `odometerKm` | Fraud | The headline claim; monotonicity across versions is the demo |
| 1 | `accidentCount` | Fraud | "Never written off" without disclosing incidents |
| 2 | `ownerCount` | Fraud | Title-washing signal |
| 3 | `serviceCount` | Fraud | Maintenance evidence without the service book |
| 4 | `writeOffCategory` | Fraud | 0 = none; category codes above |
| 5 | `firstRegistrationDate` | Identity | Epoch days |
| 6 | `lastInspectionDate` | Identity | Epoch days |
| 7 | `co2FootprintKgCO2e` | Art 46 | Environmental declaration |
| 8 | `recycledPlasticPct` | Art 29 | Recycled-content target |
| 9 | `recycledPlasticFromELVPct` | Art 29 | Share sourced from end-of-life vehicles |
| 10 | `recycledSteelPct` | Art 29 | Recycled-content target |
| 11 | `recycledAluminiumPct` | Art 29 | Recycled-content target |
| 12 | `criticalRawMaterialPct` | Art 46 | CRM declaration |
| 13 | `reusabilityPct` | 3R | Inherited from Directive 2005/64/EC |
| 14 | `recyclabilityPct` | 3R | Inherited from Directive 2005/64/EC |
| 15 | `recoverabilityPct` | 3R | Inherited from Directive 2005/64/EC |
| 16 | `dismantlingTimeMinutes` | Art 46 | Design-for-dismantling evidence |

### Reserved numeric — slots 17–21

Deliberately empty. Absent leaves are still salted and still anchored, so occupying one later costs
a re-anchor but no reordering.

### String — slots 22–29

| # | Field | Serves | Note |
|---|---|---|---|
| 22 | `vinHash` | Fraud | Identity; disclosed only at authority tier |
| 23 | `vehicleCategory` | Art 46 | M1 / N1 / etc. |
| 24 | `euTypeApprovalNumber` | Art 46 | Binds to type approval |
| 25 | `manufacturerBPN` | Supply chain | Business partner number |
| 26 | `fuelType` | Art 46 | Powertrain classification |
| 27 | `batteryChemistry` | Interop | Mirrors the battery passport's own field |
| 28 | `emissionsClass` | Art 46 | Euro standard |
| 29 | `batteryPassportId` | Interop | **The explicit link to a battery passport** |
| 30 | `passportOrigin` | Art 46 | `new` — issued at first placing on the market; `retrofit` — added to a vehicle produced before the regulation applies. Provisional occupancy 2026-08-27; the two paths share fields today, and this is how a record says which it took |

### Reserved string — slot 31

---

## Why the reserve exists

The previous 16-slot panel was full on day one, and twelve credible fields had to be cut — several
plausibly mandatory once 2026/1738 applies in 2028. Filling 32/32 would repeat that mistake at a
larger scale.

Six reserved slots is roughly 19% headroom, split by type so either kind of field can be added
without reordering. Anything beyond that needs a genuine re-anchor round, which the SDK's own
guidance says to do **in one batch, never field by field**.

## Where our passport ends — SETTLED (2026-08-27)

ShieldVIN covers the **vehicle's** record. An EV's battery is a separate regime with its own
passport, mandatory from February 2027 under
[Reg (EU) 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj), and
[NIGHTPASS](https://github.com/ODATANO/NIGHTPASS) covers that ground.

**Slot 29 `batteryPassportId` is clearly ours to hold** — it is the reference out, populated only
when the vehicle is electric. That reference *is* the regulation's interoperability clause made
concrete, and it is what makes a NIGHTPASS composition demo real rather than rhetorical.

**Slot 17 `batteryStateOfHealthPct` returns to the reserve.** State of health is a claim about
the battery, not about the vehicle. Holding it here would restate someone else's record, and the two
would eventually disagree — at which point a verifier has two answers and no way to choose. The
battery passport is authoritative for the battery; we hold the link and stop.

**Slot 27 `batteryChemistry` stays.** It is descriptive rather than a claim, so it carries no
divergence risk of the same kind.

Raised with ODATANO on 2026-08-27 and agreed. Their wording: *"state of health is the battery
passport's claim; a mirror here is a second record that will diverge"*, while slot 29 *"is the link:
an EV carries the battery passport id from our side, a verifier follows it into the battery passport
and checks there instead of trusting a copy."*

The change costs nothing today: nothing is anchored yet, and absent slots are salted empty leaves
either way.

---

## Operational requirements

**Prover keys must be fetched before the first proof.** The 32-slot keys are not packed into npm:

```bash
npx nightgate-fetch-keys attestation-vault-32
```

*"Prover keys are part of the artifact generation digest. A server booting without them says so by
name; container images already contain them."*

**Every document-bound action must name the wider vault** — `compiledArtifactRef:
'attestation-vault-32'` — and browser consumers import
`@odatano/nightgate/browser/attestation-vault-32` and pass `slotWidth: 32` to the `prepare*` helpers.

**`allowedMask` widened to Integer64.** SQLite needs nothing. **PostgreSQL and HANA need a schema
redeploy** — which bites at deployment rather than in development, since we develop on SQLite.

---

## Verification status

**Verified by execution against the installed `@odatano/dpp-sdk@0.2.0` — 24/24 on 2026-08-23.**
Run it yourself:

```bash
npm run test:sdk        # test/sdk-assumptions.mjs
```

Re-run after **any** `@odatano/*` version bump. ODATANO shipped 0.17.2 → 0.19.0 in four days, so
treat a passing run as valid only for the version it ran against.

| Claim | Status |
|---|---|
| `VAULT_SLOT_WIDTHS = [8, 16, 32]` | ✅ executed |
| `MERKLE_DEPTH = 4` is a default, not a cap | ✅ executed |
| `depthForWidth` / `widthForDepth` — 16 ↔ 4, 32 ↔ 5 | ✅ executed |
| `depthForWidth` rejects non-powers-of-two | ✅ executed |
| `VALUE_SCALE = 1000`, numerics ×1000 into Uint64 | ✅ executed |
| Numeric fields precede all string fields | ✅ executed |
| `fieldKeyHex` = blake2b-256 of the field name | ✅ executed |
| `padToWidth` throws on overflow rather than truncating | ✅ executed |
| Depth-5 tree: 6 levels, 5-sibling paths, all 32 proofs verify | ✅ executed |
| A proof for one slot does not verify another (soundness) | ✅ executed |

### Two things execution revealed that reading did not

**The SDK itself supports up to 1024 slots.** `depthForWidth` rejects bad input with *"slot width
must be a power of two in 2..1024"*. So 32 is not an SDK limit — it is the widest **vault contract
lineage NIGHTGATE ships**, bounded by wasm proving memory (their note: the ceiling is hit at 64). If
a future panel genuinely needed 64, the blockers are the contract and prover memory, not this
library.

**Overflow messages are specific** — *"33 entries do not fit a 32-slot tree"* — so a registry that
outgrows its width fails loudly and legibly rather than silently dropping fields.

### Still to confirm by running the full stack

- [ ] A 32-slot custom panel needs no contract change beyond naming `attestation-vault-32`
- [ ] Proving time, memory and DUST cost at width 32 versus 16 — Phase 0 cost measurement (Q5)
- [ ] `contentSaltSeed` persistence, and a tested restore path

Note that `@odatano/dpp-sdk@0.2.0` was published to npm **without a corresponding commit in the
GitHub repository**, which still shows only 0.1.0. Verify against the installed package, not the
repo — which is exactly what `test:sdk` does.
