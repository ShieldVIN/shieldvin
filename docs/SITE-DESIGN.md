# Site design rules (passport.vin front door)

The site in `site/` was hand-designed and delivered as a finished artifact on
2026-08-28. The rules below are the designer's handoff and they bind every
future edit. Status of the handoff's open items, as integrated:

- Placeholder links: wired. Nav and hero go to `/verify/`; the three surface
  cards go to `/console/`, `/proofs/`, `/verify/`; contract and repo links
  point at VINPassport/VINPassport. Still pending: the 90-second walkthrough
  link (waits for the video).
- Repo links: updated for the VINPassport rename.
- Em dashes in the mockups page prose were converted to the project's
  no-em-dash convention, and the mockup vehicle dropdowns were aligned to the
  exact names in `app/console/demo-vehicles.mjs`. The not-proven badge glyph
  stays: it is an icon, not wording.
- The published layout: `site/` at the root, the scan app at `/verify/`,
  console, proofs and deck at their own paths. See `.github/workflows/pages.yml`.

The original handoff text follows.

---

# CLAUDE.md — VINPassport site (passport.vin)

Read this before touching any file in `site/`.

## What this is

`site/` is a finished, hand-designed static site. It is not scaffolding, not a
draft, and not generated output. Three pages:

| Path | File | Audience |
| --- | --- | --- |
| `/` | `site/index.html` | Overview: what VINPassport is, how privacy works, the three surfaces |
| `/regulation/` | `site/regulation/index.html` | Reader's summary of Reg (EU) 2026/1738 and the 32-slot field registry |
| `/mockups/` | `site/mockups/index.html` | Interface mockups: intake console, proof explorer, buyer verification |

## The one rule

**Do not change the visual design.** Not the colours, type sizes, weights,
letter-spacing, padding, gaps, border widths, opacity values, wording, or the
order of anything. If a change you are asked to make would alter what the page
looks like, stop and ask first.

This includes changes that would normally count as improvements:

- Do not "clean up" the inline styles into classes or a utility framework.
  The inline styles are the design. Converting them will drift the layout.
- Do not add Tailwind, Bootstrap, a CSS reset, or any framework.
- Do not introduce a build step, bundler, npm dependency, or template engine.
- Do not reformat or re-indent the HTML. Diffs should stay small and readable.
- Do not swap the fonts. Barlow Condensed for headings, Barlow for body, a
  monospace stack for hashes and field names. Nothing else.
- Do not round any corners. Every box in this design is square by intent.
- Do not add shadows, gradients, blur, or hover animations.
- Do not add emoji, icons, or illustrations that are not already there.
- Do not "modernise" the copy. It was written carefully and deliberately
  avoids marketing tone, em dashes, and overclaiming.

## What you may change freely

- Wiring links to real destinations (see "Placeholder links" below).
- Adding pages, following the existing grammar exactly.
- Analytics, meta tags, Open Graph tags, favicon variants, `robots.txt`,
  `sitemap.xml`.
- Deployment configuration, CI, GitHub Actions.
- Accessibility fixes that do not change appearance: `alt` text, `aria-label`,
  landmark elements, heading order, `lang`, focus order. If an a11y fix would
  change appearance, propose it rather than applying it.
- Fixing a genuine bug (broken layout at some width, a typo in a URL, an
  invalid attribute). Describe what you changed and why.

## Design system in one screen

Colours, and where each belongs:

| Token | Value | Use |
| --- | --- | --- |
| Ground | `#EDE4D8` | Page background. Taken from the logo's cream |
| Recessed | `#E6DCCE` | Input fills, the command-line block |
| Ink | `#0E1726` | Body text |
| Brand blue | `#004AAD` | Headings' accent lines, ticks, primary buttons, the full-bleed statement panels |
| Deep blue | `#002E6E` | Section kickers and small text on the cream ground, for contrast |
| Periwinkle | `#8B95FF` | Reserved for exactly three meanings: demo data, a refusal, and "not proven" |
| Hairline | `rgba(0,74,173,.26)` | Every border and rule |

Type: `Barlow Condensed` 600 for headings, uppercase with light positive
letter-spacing. `Barlow` 400/500/700 for body. `ui-monospace` for hashes, field
names, slot numbers, dates in the timeline and anything a machine produced.

Structure: square corners everywhere. Hairline borders. Section headers are a
numbered uppercase kicker (`01 ·`, `02 ·`) above a full-width 1px rule. Cards
carry the blueprint frame: `class="blueprint"` plus four
`<i class="corner tl|tr|bl|br"></i>` children that draw the registration marks.
**Never delete those `<i>` elements** — they are the marks, not decoration.

Only two things live in `site/assets/site.css`: the blueprint frame rules and
the page-level tokens and resets. Everything else is inline on purpose, so a
component's full appearance is visible where it is used.

## Responsive behaviour

The pages carry **no media queries** and must keep working without them. Layout
reflows intrinsically:

- Rows are `display:flex; flex-wrap:wrap` with `flex:1 1 <basis>px; min-width:0`
  on each child, so columns collapse to one when the basis no longer fits.
- Card grids are `grid-template-columns:repeat(auto-fit,minmax(<n>px,1fr))`.
- Type and padding scale with `clamp()`.
- Ruled rows put the border on the row wrapper, never on individual cells. Two
  cells with their own bottom borders draw the rule at two different heights.
  This bug was already found and fixed once; do not reintroduce it.
- **No horizontal scrolling regions.** A table that would need one is
  linearised into wrap-flex rows instead. Verify at 320px, 390px, 768px and
  1440px after any change.

The phone artboards on `/mockups/` are fixed at 393 × 852 by design and scroll
internally with the scrollbar hidden via `.noscroll`. Leave them fixed.

## Placeholder links to wire up

These currently point at the mockups or at the repo. Repoint them when the real
destinations exist, and change nothing else about the elements:

- `SCAN A VEHICLE` (nav, both pages) and `SEE A LIVE PASSPORT` (hero) →
  currently `/mockups/#1c`. Should become the real verification app.
- The three surface cards on `/` → currently `/mockups/#1a`, `#1b`, `#1c`.
  Should become the real console, proof explorer and verification routes.
- `READ THE CONTRACT` → `github.com/VINPassport/VINPassport/tree/main/contracts`.
  Confirm that path is right, and update if the repo is renamed.
- `THE 90-SECOND WALKTHROUGH` → currently `#surfaces`. Should become the video.
- `Source` and `Midnight Network` in the verification mockup footer.
- The turn-1 intro on `/mockups/` used to link to a recreation of the previous
  app for comparison. That page is not shipped, so the link was removed rather
  than left pointing at itself. The original is in `design-source/` if you ever
  want it published, for example at `/mockups/baseline/`.

EUR-Lex links on `/regulation/` are real and correct. Do not change them.

## Content accuracy rules

The regulation page is deliberately careful, and that carefulness is the point.
Preserve it:

- Keep the "plain language, not legal advice" notice.
- Keep the note that entry-into-force, general-application and 2032 dates come
  from secondary legal analysis rather than the operative articles.
- Keep the ESPR panel. Regulation 2024/1781 explicitly excludes vehicles, and
  citing it for a vehicle passport is a factual error. That warning is there
  because it is easy to get wrong.
- Do not soften the "what this does not prove" panel on `/`. A valid proof of a
  falsely committed value is a real limitation and the site says so on purpose.
- Section 6 on `/` states precisely which parts are ours and which two ODATANO
  libraries are used, each for one narrow job. Do not broaden either claim.

## Deploying to passport.vin on GitHub Pages

`site/CNAME` already contains `passport.vin`, and `.nojekyll` is present so
Jekyll does not process the folder.

Option A, simplest — serve from a folder on the default branch:

1. Copy the contents of `site/` to the repo root (or to `docs/`).
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`,
   folder `/` (or `/docs`).
3. Settings → Pages → Custom domain: `passport.vin`. Save. Tick
   *Enforce HTTPS* once the certificate is issued.
4. At the DNS registrar for `passport.vin`, add four `A` records for the apex:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   (and the matching `AAAA` records if you want IPv6). Add a `CNAME` for `www`
   pointing at `<owner>.github.io`.
5. Verify: `https://passport.vin/`, `/regulation/`, `/mockups/` all load and the
   pages look identical to the files in this bundle.

Option B — GitHub Actions, if you want `site/` to stay a subfolder:

```yaml
name: Deploy site
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

Then set Settings → Pages → Source: *GitHub Actions*, and keep the custom
domain configured as in step 3 above.

Notes: there is no build step, so nothing to install and nothing to compile.
`CNAME` must end up at the root of whatever is published. Keep `.nojekyll`.

## Before you commit

Check all four, every time:

1. The three pages render identically to the files as delivered. Compare
   against `design-source/` if you are unsure what a section should look like.
2. No horizontal scrollbar at 320px, 390px, 768px or 1440px on any page.
3. No console errors, no 404s on assets.
4. Every link resolves. No `href="#"` anywhere.
