# Manufacturer batch intake — structure and flow

**Status: design specification, pre-implementation.** This document defines the structure,
data flow and screen inventory for the manufacturer console: the surface where a vehicle
manufacturer registers one model specification across many VINs in a single run. The visual
design is produced separately from this spec; nothing here prescribes look, only what exists,
what is shown, and in which order.

## The one-sentence version

A manufacturer picks their brand, defines a model's shared field values **once**, pastes a
list of VINs, and the system runs the real circuits per VIN off that single template —
`registerPassport` plus field initialisation for each — with every acceptance and refusal
shown per VIN, never summarised away.

## Why this fits the contract as-is

The contract has no batch primitive, and does not need one. A batch is a client-side fan-out:

```
for each VIN in the list:
    registerPassport(vinHash)          # insert-once: a VIN can never be registered twice
    initialiseField(...) x N           # from the shared model spec
    prove...(...)                      # optional standard claims, same for every unit
```

Every VIN yields its own passport, its own commitments, its own claims. A refusal for one
VIN (for example a VIN already on the ledger) affects that VIN only; the batch continues.

## Data architecture: public design, private data

The brand database compiled for this feature (44 groups, 80 brands, per-brand powertrains,
plants, segments, market status, sources) is **project data and is not committed to this
repository**. The repository carries only:

- this specification,
- the JSON **schema** of the brand database (below),
- a **sample fixture** of two illustrative groups so the interface runs in development
  and in the public demo without the real data.

At runtime the API serves whichever file it finds:

```
BRANDS_DATA=/opt/vinpassport/data/eu-car-brands.json   # real file, VPS only, outside the repo
fallback: scripts/data/brands.sample.json               # committed sample, 2 groups
```

The response never says which backing served it beyond a `dataset: "full" | "sample"` field,
so the interface can label itself honestly.

### Brand database schema (the shape the interface consumes)

```json
{
  "generatedAt": "ISO date",
  "dataset": "full | sample",
  "filterVocabulary": {
    "powertrains": ["BEV", "PHEV", "HEV", "petrol", "diesel", "hydrogen"],
    "segments": ["budget", "mainstream", "premium", "luxury", "sports"],
    "euMarketStatus": ["active", "entering", "exiting", "niche"]
  },
  "groups": [
    {
      "parent": "Volkswagen Group",
      "parentHq": "Germany",
      "brands": [
        {
          "name": "Audi",
          "hq": "Germany",
          "euMarketStatus": "active",
          "powertrains": ["BEV", "PHEV", "petrol", "diesel"],
          "segments": ["premium"],
          "manufacturing": [{ "country": "Germany", "plant": "Ingolstadt" }]
        }
      ]
    }
  ]
}
```

(The real file additionally carries `sources` per brand; the API strips them from the public
response — they are working provenance, not interface content.)

## The flow: five steps, one direction

A batch is a wizard, not a dashboard. The manufacturer moves forward through five steps;
going back never loses entered data; nothing writes to the ledger until step 5 says so.

### Step 1 — Brand

- **Shown:** parent-company groups as headings, their brands selectable beneath; filter
  chips from `filterVocabulary` (powertrain, segment, market status) narrowing the list;
  a search box matching brand and parent names.
- **Selected brand card:** name, parent, HQ, powertrains offered, EU manufacturing sites.
- **Rule:** exactly one brand per batch. The brand is recorded as the registrar identity
  prefix (`registrar: "Audi (Volkswagen Group)"`) on every passport in the batch.

### Step 2 — Model specification (the shared template)

- **Shown:** model name and variant (free text, e.g. "Q4 e-tron 45"), then the field panel
  from [FIELDS.md](FIELDS.md) split into two visibly distinct sections:
  - **Shared by every unit** — vehicle category, fuel/powertrain type (pre-narrowed to the
    brand's offered powertrains from step 1), emissions class, EU type-approval number,
    write-off category (0 for new vehicles), and the new-vehicle zeros: odometer 0,
    accidents 0, keepers 0, service entries 0.
  - **Per-VIN at registration** — first-registration date (defaults to batch date, per-VIN
    override in step 3's table), and anything else that genuinely varies per unit.
- **Claim defaults:** the standard new-vehicle claim set, on by default, individually
  toggleable: never written off, no accidents, at most one keeper, mileage under threshold.
  The circuit count per VIN updates live as toggles change (register + N inits + M claims).
- **Rule:** the spec must be complete before step 3 unlocks; incomplete required fields are
  listed by name, not as a count.

### Step 3 — VINs

- **Input:** a paste area (one VIN per line) and a CSV upload accepting a single-column
  file or a two-column `vin,firstRegistrationDate` file for per-VIN date overrides.
- **Validation table, one row per VIN, shown before anything runs:**
  - format: 17 characters, no I/O/Q — malformed rows flagged, not silently dropped;
  - duplicates inside the batch — flagged, second occurrence excluded;
  - already on the ledger — checked against the API; these will be **refused by the
    circuit** if submitted, and the table says so in advance.
- **Shown:** total pasted / valid / flagged counts; flagged rows carry the reason in words.
- **Rule:** the batch proceeds with valid rows only, and says how many it excluded. Batch
  cap: 500 VINs per run in demo mode (a server bound, restated in the UI).

### Step 4 — Review and dry run

- **Shown:** the complete batch as it will execute — brand and registrar line, the shared
  spec as a read-only panel, VIN count, circuits per VIN, total circuit executions.
- **Dry run (always available, never skippable by accident):** runs the whole batch through
  the circuits **without writing** — the server simulates against a copy of the ledger.
  Output is the same per-VIN result table as a live run, labelled as a rehearsal.
- **Rule:** the execute button states what it does: "REGISTER {N} PASSPORTS". In demo mode
  it also states where: "on the shared demo ledger (resets on restart)". Nothing implies
  chain persistence that does not exist — same honesty rule as the rest of the site.

### Step 5 — Execution and receipt

- **Shown live:** a per-VIN progress table — queued → running → **registered** or
  **refused (reason)** — plus a running counter. Refusals are results, rendered with the
  circuit's reason; the batch never halts on one.
- **On completion:** the batch receipt —
  - summary: N registered, M refused, timestamps;
  - per VIN: the vinHash, applied steps, claims proven, a link to `/verify/?v={vinHash}`;
  - **download**: a JSON receipt file of exactly the above, the manufacturer's record.
- **Resume rule:** a batch that is interrupted can be re-submitted as-is; already-registered
  VINs will be refused by insert-once and reported as such, so re-running is safe and the
  receipt distinguishes "registered now" from "was already registered".

## API surface (server additions)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/brands` | GET | The grouped brand list; query params mirror the filter vocabulary (`?powertrain=BEV&status=active`); serves full or sample dataset |
| `/api/batch/validate` | POST | VIN list + spec → the validation table of step 3 (format, in-batch duplicates, ledger collisions) |
| `/api/batch/dry-run` | POST | Full batch → per-VIN simulated results, no writes |
| `/api/batch` | POST | Full batch → executes, returns per-VIN results (demo scale is synchronous; a `batchId` field is reserved for the async chain-mode future) |

All four follow the existing server conventions: same origin plus the CORS-allowed
passport.vin origins, JSON in and out, values never echoed beyond the submitting response.

## Modes, stated plainly

- **Demo mode (first implementation):** identical trust model to the current intake console —
  real compiled circuits, shared in-memory ledger, resets on restart. This is what ships
  first and what the public demo runs.
- **Chain mode (after preprod wiring):** the same five steps, but step 5 submits real
  transactions to the deployed preprod contract, fees paid in dust from the project wallet.
  The step-5 screen gains per-VIN transaction status (proving → submitted → in block) and
  realistic timing expectations. Nothing in steps 1–4 changes, which is the point of
  designing the wizard now.

## What the visual mockup needs to show (checklist for the design pass)

1. **The wizard frame** — five steps with a visible position indicator; back never destroys.
2. **Step 1** — grouped brand list with parent headings, filter chips, search, selected-brand
   card. Show one group expanded, one filter active.
3. **Step 2** — the two-section field panel (shared vs per-VIN), claim toggles with the live
   circuit count, model/variant heading.
4. **Step 3** — paste area and upload side by side, the validation table with at least one
   of each flag type visible (malformed, duplicate, already-registered), the counts line.
5. **Step 4** — the review panel, the dry-run result table, the execute button with its
   honest label and demo-mode caption.
6. **Step 5** — the live progress table mid-run (mixed registered/refused rows), then the
   receipt state with the download and per-VIN verify links.
7. **Empty and error states** — no brand data (sample fallback note), zero valid VINs,
   server unreachable (the existing static-mode messaging pattern).

## Open decisions (settle before implementation, none block the mockup)

- Whether per-VIN overrides beyond first-registration date are worth the table complexity
  (colour is the classic candidate; the panel currently has no colour field, and adding one
  is a FIELDS.md decision, not a UI one).
- Where manufacturer authentication lives when this leaves demo mode (the demo needs none;
  chain mode spending our dust on strangers' batches obviously does).
- Whether batch receipts should also be retrievable server-side later (`GET /api/batch/:id`)
  or remain download-only; download-only keeps the server stateless and is the default.

## Relationship to the rest of the project

This console is a fourth surface beside verify / intake / proofs, aimed at the OEM side of
the customer picture in [ROADMAP.md](ROADMAP.md); the existing intake console remains the single-vehicle path for
dealers and workshops. It reuses the field panel, the claim vocabulary, the honesty rules
and the server conventions already established. The private brand database powers it but is
not part of it: the repository stays complete and runnable on the sample fixture alone.
