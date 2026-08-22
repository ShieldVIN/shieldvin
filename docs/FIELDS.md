# Provable field registry

> **Headline finding: a credible vehicle field panel fits in NIGHTGATE's 16 slots — but exactly,
> with zero headroom.** This is the tightest constraint in the whole design and the first thing to
> raise with the ODATANO maintainer.

## The constraint

NIGHTGATE's content tree is fixed at **depth 4 = 16 leaves** (`MERKLE_DEPTH = 4` in `@odatano/dpp-sdk`).
A provable field *is* a slot in a frozen, ordered array. Its leaf index is its position in that array.

Three consequences follow, and all three are unforgiving:

1. **Sixteen is the hard cap.** A seventeenth field means depth 5, which means new circuits in the
   `attestation-vault` Compact contract — leaving the "no Compact toolchain required" comfort zone
   and requiring upstream cooperation.
2. **Changing the registry changes every root.** Adding, removing or reordering a field alters the
   content root and schema id of *every* passport, forcing a re-anchor of all of them. The SDK's own
   guidance: extend in **one batch with a re-anchor round, never field by field**.
3. **Ordering is load-bearing.** Numeric fields must precede string fields. Numerics are scaled to
   milli-units (×1000) into a Uint64; strings commit to a hash of the exact string.

## Proposed panel — 16/16 slots

Chosen to serve both the circularity obligation in
**[Regulation (EU) 2026/1738](https://eur-lex.europa.eu/eli/reg/2026/1738/oj)** and the fraud cases
that make the passport worth reading. Numerics first, per the ordering rule. Recycled-content slots
trace to Article 29; the passport itself to Article 46 — see [REGULATION.md](REGULATION.md).

| # | Field | Type | Serves | Why it earns a slot |
|---|---|---|---|---|
| 0 | `odometerKm` | numeric | Fraud | The headline claim. Monotonicity across anchor versions is the demo. |
| 1 | `accidentCount` | numeric | Fraud | "Never written off" without disclosing incidents. |
| 2 | `ownerCount` | numeric | Fraud | Title-washing signal. |
| 3 | `serviceCount` | numeric | Fraud | Maintenance evidence without the service book. |
| 4 | `co2FootprintKgCO2e` | numeric | 2026/1738 | Environmental declaration. |
| 5 | `recycledPlasticPct` | numeric | 2026/1738 | Recycled-content target — a core obligation. |
| 6 | `recycledSteelPct` | numeric | 2026/1738 | Recycled-content target. |
| 7 | `recycledAluminiumPct` | numeric | 2026/1738 | Recycled-content target. |
| 8 | `criticalRawMaterialPct` | numeric | 2026/1738 | CRM declaration. |
| 9 | `recyclabilityPct` | numeric | 2026/1738 | Inherited from the 3R type-approval regime. |
| 10 | `recoverabilityPct` | numeric | 2026/1738 | Inherited from the 3R type-approval regime. |
| 11 | `dismantlingTimeMinutes` | numeric | 2026/1738 | Design-for-dismantling evidence. |
| 12 | `batteryStateOfHealthPct` | numeric | Interop | **The join to the battery passport.** |
| 13 | `vinHash` | string | Fraud | Identity, disclosed only at authority tier. |
| 14 | `vehicleCategory` | string | 2026/1738 | M1 / N1 / etc. |
| 15 | `euTypeApprovalNumber` | string | 2026/1738 | Binds to type approval. |

**Slot 12 is the strategically interesting one.** Battery state of health is where a vehicle passport
and a [battery passport](https://eur-lex.europa.eu/eli/reg/2023/1542/oj) touch. Regulation 2026/1738
asks for interoperability with other vehicle
environmental passports; this field is where that stops being a slogan. It is also the natural
demonstration of ShieldVIN and NIGHTPASS composing rather than competing.

## What did not make the cut

Dropped for want of space, not want of merit — evidence that 16 is genuinely too few:

`hazardousSubstanceFlags`, `partsReusedPct`, `batteryChemistry`, `motorType`, `fuelType`,
`grossVehicleWeightKg`, `firstRegistrationDate`, `writeOffCategory`, `manufacturerBPN`,
`dismantlerFacilityId`, `emissionsClass`, `lastInspectionDate`.

Several of these are plausibly *mandatory* under the 2028 application date. If even two become
required, the panel overflows.

## Open questions for ODATANO

1. **Would depth 5 (32 slots) be considered upstream?** It is a `merkle.ts` constant plus circuit
   work in `attestation-vault`, and it would benefit any product category richer than a battery.
   Vehicles are the obvious second category and we are volunteering to be the forcing function.
2. **Is per-domain depth feasible**, or is depth necessarily global to the contract?
3. **Could `schemaId` carry the depth**, letting depth-4 and depth-5 passports coexist without a
   flag day?
4. **Is our reading correct** that a vehicle panel of ≤16 slots needs *no* change to the deployed
   `attestation-vault` contract, since leaves are keyed by opaque 32-byte field keys?

## Verification status

Everything on this page derives from reading the public ODATANO repositories, **not** from running
the code. Before any of it is built on, confirm against the actual published packages:

- [ ] `MERKLE_DEPTH = 4` in the installed `@odatano/dpp-sdk`
- [ ] Numeric scale is ×1000 into Uint64
- [ ] Strings must follow all numerics in registry order
- [ ] A ≤16-slot custom panel needs no contract change
- [ ] Salted leaves require `contentSaltSeed` persistence — and losing it makes a root permanently
      unprovable, which makes seed backup an operational requirement, not a nicety
