# Regulatory basis

Primary sources for every regulatory claim made in this repository. All links go to EUR-Lex, the
official EU law portal — free, no account, all official languages.

---

## The one that matters

### Regulation (EU) 2026/1738 — vehicle circularity and end-of-life vehicles

**[Read the full text on EUR-Lex →](https://eur-lex.europa.eu/eli/reg/2026/1738/oj)**

This is the legal basis for VINPassport. It establishes the **Digital Circularity Vehicle Passport**.

| | |
|---|---|
| Published in the Official Journal | 24 July 2026 |
| Entered into force | 13 August 2026 |
| Generally applies from | 1 September 2028 |
| Manufacturer "circularity strategy" required from | 1 September 2029 |
| **Digital Circularity Vehicle Passport mandatory from** | **1 September 2032** |
| Repeals | [Directive 2000/53/EC](https://eur-lex.europa.eu/eli/dir/2000/53/oj) (end-of-life vehicles) and [Directive 2005/64/EC](https://eur-lex.europa.eu/eli/dir/2005/64/oj) (3R type-approval) |

**Articles this project builds on:**

| Article | Subject | Relevance |
|---|---|---|
| **Article 46** | Digital Circularity Vehicle Passport | The passport itself — what VINPassport implements |
| **Article 29** | Recycled plastic content | Progressively rising targets, including a share sourced from end-of-life vehicles — drives field slots 5–7 |

The clause that shapes the architecture is the interoperability requirement: the passport must be
*aligned, interoperable and, where possible, integrated with other vehicle related environmental
passports established under Union law*. That is a direct invitation to dock with the battery
passport below — and note the verb is **interoperate**, not absorb.

VINPassport reads that as a **reference**, not a copy: slot 29 `batteryPassportId` points at an EV's
battery passport, and the battery's own claims stay in that passport where they are authoritative.
Restating them here would create two records that can disagree. Whether the panel should also mirror
`batteryStateOfHealthPct` is an open question — see [FIELDS.md](FIELDS.md).

---

## The one it must interoperate with

### Regulation (EU) 2023/1542 — batteries and waste batteries

**[Read the full text on EUR-Lex →](https://eur-lex.europa.eu/eli/reg/2023/1542/oj)**

Establishes the **battery passport** under Article 77, mandatory from **18 February 2027** — five
years ahead of the vehicle passport.

Scope is the battery, **not** the vehicle: EV batteries (any capacity), LMT batteries (any
capacity), and industrial batteries above 2 kWh. An OEM is caught because it places a battery on the
market inside a vehicle, but this regulation gives the *vehicle* no passport.

This matters for VINPassport in two ways. It is the interoperability target named by 2026/1738. And
it is already implemented on the same stack we are building on — [NIGHTPASS](https://github.com/ODATANO/NIGHTPASS)
is a battery passport on NIGHTGATE, which makes a composition demo a realistic Phase 3 goal rather
than an aspiration.

---

## The one that does *not* apply

### Regulation (EU) 2024/1781 — Ecodesign for Sustainable Products (ESPR)

**[Read the full text on EUR-Lex →](https://eur-lex.europa.eu/eli/reg/2024/1781/oj)**

ESPR is the EU's general Digital Product Passport framework, and it is the one most people reach for
when they hear "digital product passport". **It explicitly excludes vehicles.**

Article 1(2) carves out vehicles within the scope of [Reg 167/2013](https://eur-lex.europa.eu/eli/reg/2013/167/oj),
[Reg 168/2013](https://eur-lex.europa.eu/eli/reg/2013/168/oj) and
[Reg 2018/858](https://eur-lex.europa.eu/eli/reg/2018/858/oj), on the basis that vehicles are covered
by sector-specific law.

**Do not cite ESPR as the basis for a vehicle passport.** It is a factual error, and an easy one for
a regulator, investor or hackathon judge to catch. Regulation 2026/1738 is the correct and only
citation for a vehicle-level passport obligation. This is recorded as a standing warning in
[DECISIONS.md D3](DECISIONS.md#settled).

---

## Verification status

Article numbers (46, 29), the repeals, and the OJ publication date were read from the EUR-Lex text
of 2026/1738 directly.

Dates for entry into force, general application, and the 2032 passport deadline come from secondary
legal analysis rather than the operative articles. They are consistent across multiple independent
sources, but **confirm against the final provisions before using them in anything that matters** — a
submission, a partner conversation, or a compliance claim.

Nothing in this repository should be represented as legal advice.
