# Visual Direction — "The Editorial Desk"

> **Status:** v1.0 · 2026-07-06 · Awaiting approval — no implementation until approved
> **Relationship to spec:** Companion to [UI_REDESIGN_SPEC.md](UI_REDESIGN_SPEC.md). The spec owns structure, IA, flows, components, and states. This document owns _how it looks and feels_. Where the two conflict, this document amends the spec (all amendments listed in §1 and folded back into the spec upon approval).
> **Inspiration:** Primary — Weekly Fables (read as: editorial publication craft). Secondary — Linear, Vercel, Notion, GitHub, Clerk. Nothing copied; the goal is the _feeling_: premium, editorial, elegant, calm, spacious, highly readable.

---

## 0. The concept in one paragraph

This product writes, reviews, and publishes words. So the interface should feel like a **well-run editorial desk**: a calm, paper-warm workspace where the user's _content_ is the typography showcase and the _chrome_ recedes to hairlines and ink. Page titles are set in a serif — like section headings in a weekly publication — while everything operational (buttons, tables, metadata) stays in a quiet, precise sans. The palette is ink on warm paper with one deep ink-blue accent. Nothing glows, nothing bounces, nothing is boxed twice. The result should read as "publishing tool with taste," not "admin template" — the exact opposite of the default ShadCN dashboard look (cold gray #FAFAFA, Tailwind indigo, shadow-heavy cards, icon noise).

**Why this identity is _ours_:** every competitor-inspiration is a developer tool; this is a _content_ tool. Editorial typography isn't decoration here — it mirrors what the product does. That's the differentiator.

---

## 1. Spec review — amendments before implementation

Full re-read of UI_REDESIGN_SPEC.md completed. The structure (IA, flows, page specs, components, states, a11y, roadmap) holds and is unchanged. Seven amendments, all in the visual layer:

| #   | Spec section      | Change                                                                                                                                                                                   | Reason                                                                                                            |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A1  | §6.1 Typography   | Add serif display family (Newsreader) for page/section titles; raise `display` to 28/36; add `display-lg` 32/40 for Dashboard greeting and auth                                          | The 24px Geist-only scale is exactly the generic dashboard look we're avoiding; editorial hierarchy needs a voice |
| A2  | §6.2 Color        | Replace cold-gray neutrals with warm paper neutrals; replace Tailwind indigo `#4F46E5` with ink-blue `#3E4C9A`; desaturate status hues (§4 below)                                        | Cold gray + stock indigo = ShadCN default; warmth + lower chroma = calm, premium                                  |
| A3  | §6.4 Surfaces     | Cards on the paper background may be _borderless with `surface` fill_ OR _hairline-bordered_ — but the page never mixes both patterns in one region; shadows remain floating-layers-only | Softens the "grid of outlined boxes" admin look                                                                   |
| B1  | §6.5 Buttons      | Primary buttons use `ink` (near-black) fill, not accent fill; accent is reserved for links, focus, active nav, and selected states                                                       | A black primary button reads editorial/premium (Vercel, Clerk); an indigo one reads template                      |
| B2  | §6.9 Motion       | Add 150ms fade-up (4px) on route-level content enter, staggered 30ms for list items (first 5 only), behind `prefers-reduced-motion`                                                      | One quiet signature motion; everything else unchanged                                                             |
| C1  | §4.1/§8 Dashboard | Greeting line becomes a serif "masthead" with the date set like a publication dateline                                                                                                   | Free identity moment on the most-visited page, zero structural change                                             |
| C2  | §6.8 Icons        | Confirmed Lucide, but at 1.5px stroke and `ink-muted` only — icons never carry the accent color                                                                                          | Keeps icons as punctuation, not decoration                                                                        |

Everything else in §6 (spacing scale, radius, skeletons, alerts, empty states) survives with recolored tokens. **No changes** to §1–5, §7–12 beyond token references.

---

## 2. Typography — the identity carrier

Three families, three jobs, loaded via `next/font` (self-hosted, zero layout shift):

| Family                                 | Role                     | Where                                                                                                 |
| -------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Newsreader** (serif, optical sizing) | Voice — display & titles | Page titles, dashboard masthead, section headers, empty-state titles, auth headline, big stat numbers |
| **Geist Sans** (existing)              | Workhorse — UI & body    | Everything else: body, buttons, forms, nav, post content, tables                                      |
| **Geist Mono** (existing)              | Precision — data         | Timestamps, counts in tables, IDs, character counters, cron times                                     |

### Scale (amends spec §6.1)

| Token         | Family     | Size/line | Weight | Use                                                                                  |
| ------------- | ---------- | --------- | ------ | ------------------------------------------------------------------------------------ |
| `display-lg`  | Newsreader | 32/40     | 500    | Dashboard masthead, auth headline                                                    |
| `display`     | Newsreader | 28/36     | 500    | Page titles (one per page)                                                           |
| `title`       | Newsreader | 20/28     | 500    | Section headers, card titles that name a _thing_ (company name, modal titles)        |
| `heading`     | Geist      | 15/22     | 600    | Operational card titles, table groupings, sub-nav                                    |
| `body`        | Geist      | 14/22     | 400    | Default UI, post content (post content at 15/24 in ApprovalCard — reviewers read it) |
| `body-strong` | Geist      | 14/22     | 500    | Buttons, labels, emphasis                                                            |
| `small`       | Geist      | 13/20     | 400    | Metadata, help text                                                                  |
| `micro`       | Geist      | 12/16     | 500    | Badges; uppercase eyebrow labels, tracking +0.06em                                   |
| `data`        | Geist Mono | 13/20     | 400    | Numbers, times, counters                                                             |

Rules:

- Serif appears **only at 20px and above**, never in body or controls — that's the line between editorial voice and operational clarity.
- Newsreader at weight 500 (never 700 — heavy serif turns "newspaper obituary").
- Reading measure: post text and paragraphs never exceed ~65ch.
- The "eyebrow" pattern (micro uppercase `ink-muted` label above a serif title) is our standard section opener — it replaces boxed section headers everywhere.

---

## 3. Color — ink on paper

### Neutrals (warm, replaces spec §6.2 grays)

| Token            | Value     | Use                                          |
| ---------------- | --------- | -------------------------------------------- |
| `paper`          | `#FAF9F7` | App background — warm, not gray              |
| `surface`        | `#FFFFFF` | Cards, panels, modals, inputs                |
| `surface-subtle` | `#F3F1EC` | Hovers, wells, table stripes, code-ish chips |
| `border`         | `#E8E5DF` | Hairlines (1px, always)                      |
| `border-strong`  | `#D6D2C9` | Input borders, interactive-card hover        |
| `ink`            | `#211F1C` | Primary text, primary buttons                |
| `ink-muted`      | `#6F6A61` | Secondary text, icons, eyebrows              |
| `ink-faint`      | `#A8A399` | Placeholders, disabled, timestamps           |

### Accent & semantics (desaturated — "printed", not "lit")

| Token          | Value              | Use                                                                        |
| -------------- | ------------------ | -------------------------------------------------------------------------- |
| `accent`       | `#3E4C9A` ink-blue | Links, focus ring, active nav indicator, selected states, checked controls |
| `accent-hover` | `#333F82`          | Link/nav hover                                                             |
| `success`      | `#3A7D5C`          | published, connected, approved                                             |
| `warning`      | `#996A1F`          | pending, flagged, reconnect                                                |
| `danger`       | `#B4483E`          | failed, rejected, destructive                                              |
| `info`         | `#41649B`          | sent_to_buffer                                                             |

Tinted backgrounds (badges, alerts) = semantic color at ~8% over `surface`, text at the full semantic value — all pairs ≥4.5:1 (verified before Phase 1 merge).

**Distribution discipline:** a typical screen is ≥95% neutrals. Accent appears in at most three places per viewport (active nav, a link cluster, one selected state). Status colors appear only inside `StatusBadge`, `ConnectionDot`, `AttentionCard`, and `Alert` — never on free text or icons. This discipline _is_ the premium look; it also makes the rare color mean something.

Light mode only for this redesign (dark mode is a future track; tokens are structured so it's a palette swap, not a refactor).

---

## 4. Spacing, layout rhythm, and the "editorial grid"

The spec's 4px scale and containers stand (§6.3). The rhythm amendments:

- **More air at the top:** 48px between the page title block and first content (spec had 32px page-section spacing; the title block gets the larger gap). Page titles breathe like article headlines.
- **Left-aligned title blocks, no centered headers** except auth and empty states.
- **Hairline dividers over boxes** for in-page section separation (Dashboard sections, Activity day groups): eyebrow + serif header + 1px `border` rule, not a wrapping card. Cards are reserved for _interactive units_ (a post, a source, a channel) — if you can't click it or act on it, it probably shouldn't be boxed.
- **Reading column bias:** queues and forms sit at their max-widths (720/640px) _left-aligned within the content area_, not centered — like a manuscript margin, and consistent with the sidebar anchoring everything left. (Exception: ApprovalCard stack stays centered per spec §4.6 — it's a focus surface.)
- Sidebar on `paper` with no border — separated from content by background continuity and spacing, not a line. Content region also `paper`; only cards are white. (This inverts the typical white-page/gray-sidebar admin scheme.)

---

## 5. Iconography

Lucide, 1.5px stroke (amendment C2):

- Sizes: 16px inline, 18px nav, 20px empty states — never larger. Big icons are the fastest route to "template".
- Color: `ink-muted` at rest, `ink` on hover/active. **Never** the accent, never semantic colors (status is carried by badges/dots with text).
- Density budget: max one icon per row/control. Nav items: icon + label. Buttons: text-only except universally understood glyphs (+, ×, ⋯, ↗).
- Empty states get a single hairline icon in `ink-faint` — quiet, not illustrative mascots.

---

## 6. Component styling notes (delta over spec §6.5–6.7)

- **Buttons:** `primary` = `ink` fill, `paper` text, radius 6, no shadow; hover lifts to `#000`. `secondary` = `surface` + `border-strong`. `ghost` = text-only, hover `surface-subtle`. `danger` = `danger` fill, confirm-dialogs only. Height 36px; `data`-font counters never inside buttons.
- **Cards:** `surface`, radius 8, hairline `border`; interactive cards hover to `border-strong` + shadow-sm (2px 8px, 4% ink). No resting shadows anywhere (spec rule upheld).
- **Inputs:** `surface`, `border-strong`, radius 6; focus = 2px `accent` ring outside a 1px gap (crisp, printed feel). Labels `body-strong`, help text `small ink-muted`.
- **Badges:** tinted pill per §3; dot variant for connections. Text always, per spec.
- **Tables:** header `micro` uppercase eyebrow style; hairline horizontal rules only; numeric/time columns in `data` mono, right-aligned.
- **TabBar:** text tabs in `body-strong ink-muted`; active = `ink` + 2px `accent` underline. Counts in `data` mono ("Approvals · 4").
- **Toasts:** `ink` fill, `paper` text (inverse chip, bottom-left) — the one inverse surface in the app, so it's unmistakably transient.
- **Skeletons:** `surface-subtle` shimmer on `paper` — barely-there, per motion rules.
- **Focus ring:** `accent`, always visible on `:focus-visible`, on every surface including `ink` buttons (ring sits outside the fill).

---

## 7. How every page should feel

One sentence of intent each — the emotional spec engineers should sanity-check against:

| Page                 | Feel                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **Dashboard**        | The front page of your morning paper: a serif masthead, a short list of what matters, then quiet. |
| **Companies**        | A shelf of imprints — each card a nameplate, not a data dump.                                     |
| **Company Overview** | The desk for one publication: today's status at a glance, this week's issue below.                |
| **Posts**            | The archive room — dense but ordered; mono timestamps, clean rules between entries.               |
| **Approvals**        | The proofreading desk: one manuscript at a time, generous type, three quiet verbs.                |
| **Media**            | A photo contact sheet — the images are the interface; chrome vanishes.                            |
| **Sources**          | The wire desk: feeds ticking in, states legible at a glance.                                      |
| **Activity**         | The ledger: austere, chronological, trustworthy; mono times, plain sentences.                     |
| **Settings**         | The production office: unhurried forms, one clear save, danger kept behind glass.                 |
| **Admin**            | Back office: utilitarian tables, zero ornament — competence as aesthetic.                         |
| **Auth**             | The title page: serif headline, one field group, nothing else in the world.                       |

### Feel sketches (type + tone, complementing the spec's structural wireframes)

Dashboard masthead (amendment C1):

```
paper background · no card

  MONDAY, 6 JULY 2026                                ← micro eyebrow, ink-faint
  Good morning, Emili.                               ← display-lg, Newsreader
  ────────────────────────────────────────────────   ← hairline rule
                                                     ← 48px air
  NEEDS ATTENTION                                    ← micro eyebrow, ink-muted
  ┌ surface card ──────────────────────────────┐
  │ ● 4 posts awaiting approval — Acme  Review →│    ← body + accent link
  └─────────────────────────────────────────────┘
```

ApprovalCard (the product's hero surface):

```
  ┌ surface · hairline · radius 8 ─────────────────────┐
  │  LINKEDIN                        MON 9:00 · data   │  ← eyebrow + mono time
  │                                                    │
  │  We're excited to announce that Acme is            │  ← body 15/24, 65ch,
  │  opening its Sofia studio this September —         │    ink, real reading
  │  and we're hiring.                                 │    typography
  │                                                    │
  │  #hiring #sofia                                    │  ← small, ink-muted
  │  [ thumbnail ]                                     │
  │  ──────────────────────────────────────────────    │  ← hairline
  │  Edit        Reject                  [ Approve ]   │  ← ghost·ghost·ink
  └────────────────────────────────────────────────────┘
```

Settings form header pattern (all five sub-pages):

```
  BRAND                                               ← eyebrow
  Voice & identity                                    ← title, Newsreader 20
  How the assistant should sound and look.            ← small, ink-muted
  ─────────────────────────────────────────────
  (form fields, 640px, left-aligned…)
```

---

## 8. Consistency system — how this survives implementation

1. **Tokens are law.** Every value in §2–3 lands as a Tailwind 4 `@theme` token in `globals.css` in Phase 1. Component code references tokens only; raw hex/px in a component is a review-blocking offense (spec §6 rule, restated).
2. **Components are the only vocabulary.** Pages compose the §7 spec library; a page never styles a status, button, or card locally. If a page needs a new pattern, the pattern is added to the library first (user's rule: never redesign a page independently — enforced structurally).
3. **The five checks** for every PR that touches UI: (1) one serif title, one primary action; (2) accent count ≤3 per viewport; (3) icons ≤1 per row, `ink-muted`; (4) no resting shadows, no double-boxing; (5) empty/loading/error present per spec §4.
4. **A living reference page** at `/dev/style` (dev-only route, excluded from build in production) rendering all tokens and components — the visual regression surface and the arbiter for "does this look right?".
5. **This document + the spec travel together.** Amendments A1–C2 are folded into UI_REDESIGN_SPEC.md §6 upon approval so implementers read one consistent source.

---

## 9. Implementation ground rules (restating the contract)

Upon approval: follow UI_REDESIGN_SPEC.md exactly (with §1 amendments) · preserve all business logic, services, APIs, DB schema · preserve routes except the two spec-mandated renames (`/approval`→`/approvals`, `/audit-log`→`/activity`, both redirected) · build the design system and reusable components first (Phase 1) · then page by page per the spec's 7-phase roadmap · conventional commit after every completed phase · `npm run typecheck && npm run lint` before each commit.

**→ Approval needed on:** the Editorial Desk direction overall, the Newsreader serif pairing (A1), the warm-paper + ink-blue palette (A2), and black primary buttons (B1). Everything else follows mechanically.
