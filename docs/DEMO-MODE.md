# Demo mode: real preprod runs, for anyone

Wave 1 status: **engine and API built and proven; public UI ships in Wave 2's
"full preprod wiring" milestone.** Everything below runs today behind
`VINPASSPORT_PREPROD=1`.

The site's intake console runs the real compiled circuits in-process, which
proves the contract logic but not the chain. Demo mode closes that gap: a
visitor triggers a run that registers a passport, records history, and proves
claims **on the deployed preprod contract** (`deploy/preprod.json`), pays real
dust fees from the project wallet, and walks away with two artifacts:

1. **On-chain evidence** — transaction hashes and block heights anyone can
   check against the public indexer, plus the exact `curl` to do it.
2. **A receipt file** — the *private half* of the passport: every value and
   salt, none of which ever touched the chain. The receipt is the ownership
   proof: whoever holds it can open the commitments; nobody else can.

## Two routes, one engine

| Route | Who drives | What happens |
|---|---|---|
| **Guided** (`POST /api/demo/run`) | The server | A plausible vehicle is generated (fresh random `VPD…` VIN), registered with four live fields and a panel of declarations, given one odometer update, then asked four questions — **one of which is designed to fail**: "one keeper" on a two-keeper car. The visitor watches the circuit refuse it, and the refusal appears in the report as a result, not an apology. |
| **Manual** (`POST /api/demo/intake`) | The visitor | The same intake shape the console uses — fields, panel declarations, up to two update rounds, requested claims — but executed on preprod. The VIN is **always server-generated** (`VPD` prefix): demos never squat a real VIN and never collide with each other. |

Both routes share one queue (runs never conflict), one engine, and one cap.

## The cap

**5 runs per UTC day, global, guided and manual counted together.** The status
endpoint shows used/remaining and the reset time, so the limit is visible
before anyone starts. A run counts when it starts, whether or not it succeeds
— retry-spam cannot stretch the budget. The cap exists because every run
writes permanent public state and spends real (self-replenishing) dust.

## Anatomy of a run

```
simulate      dry-run every step through the compiled circuits, locally.
              In-circuit refusals are caught HERE, reported, and never
              submitted — a failed proof writes nothing, so nothing is sent
              that would fail.
wallet        confirm the funding wallet is at the chain tip.
then per stage (a stage = one transaction, up to 8 batched calls):
  build       prove the contract calls in-process (wasm), sign with our key
  fund        balance the fee in dust from our wallet, prove the dust spend
  submit      one-shot WebSocket JSON-RPC to the preprod node
  confirm     watch the public indexer until the call is in a block
receipt       assemble the downloadable report
```

Every call gets its **own transaction**, applied in dependency order:
register, then each field initialisation, then each update, then each claim.
Learned the empirical way: the node 1010-rejects our multi-call batches even
when every call in the batch is independent, while single-call transactions
land first try. (Whether that is batch segment ordering or same-map write
merging is a Wave 2 investigation — the demo does not bet on it. The engine
caps a run at 10 on-chain calls.)

A guided run is seven transactions and lands in roughly ten minutes; the job
API exposes each step's live status so a UI can render the wait as the story
it actually is: *this is a zero-knowledge proof being made and a real chain
accepting it*.

## The API

| Endpoint | Returns |
|---|---|
| `GET /api/demo/status` | `enabled`, `ready`/`warming`, capacity/used/remaining, reset time, queue length, contract address |
| `POST /api/demo/run` | `202 {jobId}` — guided run queued |
| `POST /api/demo/intake` | `202 {jobId}` — manual run queued (body: `fields`, `panel?`, `updates?`, `prove?`, `registrar?`) |
| `GET /api/demo/job?id=` | Job status + per-step progress + receipt when done |
| `GET /api/demo/report?id=` | The receipt as a file download |
| exhausted cap | `429` with the reset time |
| refused/failed steps | In the report, with the in-circuit reason |

## The receipt is the passport

The receipt carries the VIN, every field's value+salt per write, the panel
declarations, the per-run salt seed and the derivation rule, the content root,
the claim outcomes (proven / refused), and the transaction list with the
indexer query to verify it. Two properties worth stating plainly:

- **Completeness**: the content root and every field commitment can be
  recomputed from this file alone. Holding it *is* owning the passport.
- **Privacy**: each run uses a fresh random salt seed, so no two demo
  receipts are linkable and no receipt reveals anything about another run.

## Trust and key model

- The server holds the **only** writer key (the deploy wallet). Visitors
  never hold keys, sign nothing, and cannot write anything except through
  the capped, validated demo endpoints.
- Secrets stay in two env-pointed files outside the repo: the seed file and
  the wallet snapshot directory. Nothing in `site/` or this repo can reach
  them.
- The public site (GitHub Pages) stays static; only the API host runs the
  engine. CORS on `/api/*` admits exactly the passport.vin origins.

## Enabling it

```
VINPASSPORT_PREPROD=1
VINPASSPORT_SEED_FILE=/path/to/seed.env        # VINPASSPORT_SEED_HEX=<128 hex>
VINPASSPORT_STATE_DIR=/path/to/wallet-state    # {shielded,unshielded,dust}.blob
VINPASSPORT_DEMO_CAP=5                         # optional
node scripts/app-server.mjs
```

Without `VINPASSPORT_PREPROD=1` the server is exactly what judges clone and
run: in-process circuits, in-memory ledger, no wallet, no chain, no secrets.
