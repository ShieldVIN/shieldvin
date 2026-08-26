# Contracts

ShieldVIN's own Compact contracts. Layout follows
[NIGHTGATE's convention](https://github.com/ODATANO/NIGHTGATE/tree/main/contracts) —
`<name>/src/<name>.compact` with compiled output under `src/managed/<name>/`.

| Contract | Circuits | Purpose |
|---|---|---|
| `shieldvin-passport` | `registerPassport`, `initialiseField`, `recordField`, `proveFieldAtMost`, `proveFieldAtLeast` | The vehicle passport: registration, and any panel field held as private state under its own integrity rule |

## Building

**Compact has no native Windows binary, and on a Windows host `compact` resolves to the built-in
NTFS compression utility.** Always build in WSL2, macOS, or Linux.

```bash
compact compile contracts/shieldvin-passport/src/shieldvin-passport.compact \
                contracts/shieldvin-passport/src/managed/shieldvin-passport
```

Add `--skip-zk` for a fast syntax and type check that skips PLONK key generation.

Verified with **Compact CLI 0.5.2, compiler 0.31.1 (language 0.23, ledger 8)** — the stable line.
The ledger-9 line (compiler 0.33+) is not deployed to any public network.

## The private-state model

The odometer reading never reaches the ledger. Only `persistentCommit(reading, salt)` is stored.

`recordField` requires the caller to open the *existing* commitment in-circuit — proving they know
the current value — then asserts the change respects the field's rule, and replaces the commitment.
Both values stay witnesses throughout, so the chain records that an integrity check passed without
recording what passed it.

**The rule is per field and fixed at creation.** An odometer, an accident count, a keeper count and
a write-off category may never fall. A battery's state of health may never rise. Storing the rule on
the ledger rather than accepting it per call is what stops a caller choosing the flattering rule at
the moment they need it; recreating a field to change its rule is refused.

`proveFieldAtMost` and `proveFieldAtLeast` do the same for a public bound: they prove the hidden
value sits at or below, or at or above, a threshold without disclosing it. *"Never had a reported
accident"* is simply `proveFieldAtMost` with a bound of zero.

## What this does and does not prove

It proves a reading is **the one that was committed** and that it satisfies a bound. It does not
prove the reading matches physical reality — a producer who commits a false value produces a
cryptographically valid proof of a false fact.

That gap is closed by hardware attestation at source, which is Phase 2. See
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
