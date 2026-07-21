# UI Redesign Specification — AI-First Social Networks Post Assistant

> **Status:** v2.2 · 2026-07-20 · Official UI/UX blueprint for the redesign — reconciled with shipped code
> **Audience:** Frontend engineers and designers. This document is the single source of truth for every UX decision. Engineers implementing from this spec should not need to make UX decisions on their own.
> **Scope:** Reorganization and redesign of the existing functionality only. No feature additions, no business-logic changes, no removals.
> **Design direction:** An original design language derived from first principles — see _Design Philosophy_ below. No reference product is imitated; every decision must survive the five questions in that section. Approved visual identity: **Direction A — The Reading Room** (rationale in _Visual Identity_, concrete tokens in §6).

### What changed in v2.2

**The shape language softened; the identity did not change hands.** Larger radii (8/14/16 vs 4/6/10), a resting card shadow, accent tints behind KPI icon tiles, and an accent-filled page-level primary button. Direction A remains the identity: the palette, the two typefaces, the type roles, the spacing rhythm, the status map and the whitespace-first grouping are all untouched, and every new tint is an existing status colour or the accent — no hue entered the palette.

**Why this is a real concession, recorded as one.** The Visual Identity section rejected Direction C partly because roundness and shadow are fashion and "fail the five-year test soonest". v2.2 moves a measured distance toward that language, and the risk is the one the spec already named. Two guardrails keep it from becoming Direction C: elevation stays at one low-contrast level and never stacks, and colour still carries meaning only through the status map — the tile tints identify a metric, never a state. If cards start nesting shadows or tints start meaning "bad", the concession has gone too far and should be walked back.

**What did not change:** §6.1 typography, §6.2 palette and status map, §6.3 spacing, §6.6–6.9. Density, motion and the compact table mode are as specified in v2.0.

Affected: Visual Identity (this note), §6.4, §6.5, §9.3 (Overview composition), §4.4.

### What changed in v2.1

One reversal, made deliberately and recorded rather than absorbed silently. **Approvals is no longer a workspace tab**; the queue is the Posts page filtered to `pending_approval`, and the status filter grew from four choices to five to hold it. v2.0 argued the opposite in §2.3 — that burying the queue one filter deep cost a click on the hottest path. That argument was right about the click and silent about the price: the queue and the Posts tab rendered the same posts, from the same service, through two components (§2.1 row 5), and Phase 5 was scheduled to reconcile them. Deleting one is cheaper than merging two, and the count badge — the tab's real contribution — moved to Posts intact.

Affected: §2.1 (row 5 closed), §2.2, §2.3, §2.6, §4.5, §4.6, §5.2–5.4, §8 attention row, §9.1, §9.2, §9.4, §9.7, §12. Everything else stands. **Anything v2.1 does not name is unchanged from v2.0 below.**

### What changed in v2.0

v1.0 was written on 2026-07-06 against a codebase where none of it had been built. Since then Phases 1–2 shipped, Phase 3 shipped partially, **Phase 4 shipped in a divergent half-finished form**, and four features landed that v1.0 never described. v1.0's assumptions about the starting state are therefore obsolete, and a document that misdescribes the code cannot be a source of truth.

This revision:

- **Keeps the approved vision unchanged.** The IA of §2.2, the Reading Room identity of §6, the principles of §1, and the flows of §3 all stand. Nothing about the target state is being renegotiated.
- **Replaces "what exists today" with what actually exists.** Every "currently the app does X" claim was re-verified against the code; obsolete ones are rewritten or removed.
- **Documents the four undescribed features** — post analytics, content mix, post status filters, per-user LLM preference — and assigns each a home in the IA (§2.6).
- **Rewrites §12** from a greenfield 7-phase plan into a resumption plan that states, per phase, what is done, what diverged, and what remains.

**Terminology:** "Shipped" = in `main` and verified. "Divergent" = built, but not as specified — it must be corrected, not preserved. "Target" = specified, not yet built.

**Existing functionality this spec reorganizes (unchanged):** company CRUD & membership, brand guidelines, Buffer OAuth & channel configs, content sources & ingestion, AI post generation (manual + weekly cron), approval workflow (approve / reject / submit / edit / restore versions), publishing to Buffer with retry, media gallery (upload + AI generation + attach/detach), audit log, global admin (users, companies, LLM configs), EN/BG i18n, **post analytics via Buffer (v2-7), content mix quotas (v2-8), post status filters, per-user preferred LLM, email verification**.

---

## Executive Summary

**The original problem (v1.0, 2026-07-06).** The app's functionality was complete but its UX undermined it: the company page was a single ~7-section scroll mixing brand forms, team management, integrations, and post review; daily-work pages hid behind module cards at the bottom of that scroll; and the global sidebar contained four permanently disabled links. Setup and daily work competed on every surface, so the product's core promise — "review your week's posts in 15 minutes" — had no fast path.

**The problem as it stands (v2.0, 2026-07-20).** The design system and global shell are fixed: the sidebar is now truthful (Dashboard / Companies / Admin), the tokens and primitives are in place, and the disabled links are gone. The company page is where the redesign stalled — and stalling made one thing _worse_ than v1.0 described:

- **The workspace split was announced but not performed.** A tab bar now exists, but five of its eight tabs (`overview`, `posts`, `sources`, `team`, `settings`) are `?tab=` query parameters served by a single 501-line page, while three (`approval`, `media`, `audit-log`) are real routes. One tab bar, two mechanics.
- **Settings was never split.** §2.4's five sub-pages are still three stacked form sections inside that same page. Brand, Buffer, and Channels remain on one scroll — the exact defect this spec was written to remove.
- **A third navigation layer appeared.** The Overview tab renders a six-card module grid duplicating the tab bar, so Posts is reachable three ways (sidebar → tab → card). v1.0 assumed module cards would be deleted _by_ the split; instead they now coexist with it.
- **Four features shipped with no specified home**, and each was placed by improvisation: content mix under Sources, post metrics inside post cards, the analytics key under Integrations, status filters as an ad-hoc bar.

The half-finished state is worse than either endpoint. A user learning the tab bar learns two inconsistent behaviors; a developer reading the page finds seven nullable bindings mutated by four sequential `if (activeTab === …)` blocks.

**The fix:** finish Phase 4 properly, then Phases 5–7 as written — and give the four new features a specified home first, so the split does not have to be redone around them.

**The fix, in four moves:**

1. **Truthful, two-level navigation (§2).** The global sidebar shrinks to Dashboard / Companies / Admin. Each company becomes a tabbed workspace — Overview · Posts · Approvals · Media · Sources · Activity · Settings — with all configuration consolidated under Settings. Disabled placeholder links are removed. — _Sidebar shipped; workspace split divergent (see §12)._
2. **Work comes to the user (§8).** A new operational Dashboard answers "what needs my attention today?": pending approvals, failed publishes, broken integrations, and upcoming automated posts — with a contextual action on every row. No analytics theater. — _Partially shipped._
3. **A fast approval loop (§3.8, §4.6).** Approving becomes a keyboard-driven pass over full-text cards with one primary action, optimistic updates, and a count badge that agrees everywhere it appears. — _Partially shipped: v2.1 (Phase 4c) collapsed the two competing implementations into one, living under the Posts page's Pending-approval filter, and made the counts agree. The card rebuild and keyboard loop remain (§12 Phase 5)._
4. **A quiet, token-driven design system (§6–7).** Neutral-first palette, one accent, a canonical status→color map, Lucide icons replacing emoji, skeleton loading, and a ~35-component library so every state (empty, loading, error) is specified rather than improvised. — _Shipped._

**What does not change:** every existing feature, service, API route, permission rule, and the EN/BG i18n requirement. This is a reorganization of the same functionality into a premium, low-cognitive-load experience.

**Delivery (§12):** originally seven sequential phases. Phases 1–2 are complete and Phase 3 is partial; Phase 4 shipped divergently and must be corrected before Phases 5–7 proceed. §12 now reads as a resumption plan (Phases 4a–4d, then 5–7) rather than a greenfield one. The workspace split remains the critical path.

---

## Design Philosophy

_This section governs everything below it. The numbered principles (§1) operationalize it; the design system (§6) implements it in the concrete form of the approved visual identity — Direction A, *The Reading Room* (see the Visual Identity section). It deliberately commits to **no** specific typeface, palette, or component styling — those are implementation choices that must merely pass the tests here. Where any earlier framing referenced other products as aspiration, this section supersedes it: resemblance to another product is never a justification — and neither is deliberate difference. Only the tests below are._

### The five questions

Every design decision — token, component, layout, interaction — must answer **yes** to at least one of these, and conflict with none:

1. Does it make the product easier to use?
2. Does it reduce cognitive load?
3. Does it make information easier to scan?
4. Does it make users trust the AI?
5. Does it help users accomplish their work faster?

"Product X does it this way" is not an answer to any of them. A familiar pattern may still be _chosen_ when familiarity itself reduces cognitive load (question 2) — but that argument must be made explicitly, per decision, and it never extends to visual styling.

### Three emotions, with mechanisms

The interface communicates exactly three things. Each is produced by concrete, checkable mechanisms — not by mood:

**1. Calm — the interface never overwhelms.**

- Generous whitespace is the primary grouping tool; density is added only where scanning demands it (tables, queues).
- Every screen has an unambiguous "look here first": one title, one primary action, content ordered by urgency with the most important above the fold.
- Nothing moves, blinks, or appears unrequested; there are no notifications — there are queues and badges the user visits on their own terms.
- Neutral surfaces dominate; color appears only where it carries meaning (the §6.2 status map).

**2. Confidence — users are trusting an AI to publish for their business; the interface must earn that.**

- **Transparency:** every automated action is visible after the fact in plain language (Dashboard automation activity, Activity timeline). The system never does anything the user cannot find a record of.
- **Predictability:** statuses form a visible, legible lifecycle; the same state always looks the same everywhere; upcoming automated actions (the next 48h of publishes) are shown _before_ they happen.
- **Reliability made visible:** failures surface immediately with their cause and a recovery action — never hidden, never euphemized. A system that is honest about its failures is the one users trust with automation.
- **Precision cues:** exact timestamps, exact counts, unambiguous wording. Vagueness erodes trust in an automated system.

**3. Focus — every page has one obvious purpose.**

- One primary action per screen; secondary actions are visually subordinate or foldered into overflow menus.
- Hierarchy comes from spacing, typography, grouping, and proportion — **not** from additional colors, borders, or effects.
- Setup and daily work never share a surface, so the working user is never distracted by configuration.

### Timelessness over fashion

- No trends, no fashionable UI, no decorative effects. No gradients unless one demonstrably serves a purpose — none currently does, so none exist.
- Animation only where it explains a state change (an item leaving a queue, a panel opening); ≤250ms; never decoration. If removing an animation loses no information, remove it.
- The test for any styling choice: _could this plausibly look dated in five years?_ If yes, it doesn't ship.

### Identity from structure, not decoration

If the logo were removed, the product should remain recognizable by:

- **Layout:** the two-level model (small global sidebar → tabbed company workspace), consistent reading columns, urgency-ordered pages.
- **Typography:** a strict division of roles — titles, working text, and data are always visually distinguishable, and each role does the same job on every screen (whatever typefaces are eventually chosen).
- **Spacing:** one consistent spacing rhythm, with deliberate air around titles and between sections.
- **Navigation:** tabs that never lie (no disabled placeholders), exactly one count badge (Approvals), counts that agree everywhere they appear.
- **Component system:** one shared component vocabulary with a single canonical status language — the same element never looks or behaves two different ways anywhere in the product.
- **Interaction patterns:** optimistic queue actions with plain-language feedback, dirty-form save bars, keyboard-first review.

That combination — not any single element, and not any particular styling — is the design language. The approved visual identity — Direction A, _The Reading Room_ — gives these structures their concrete form through the §6 tokens.

### Designed for habitual use

The target user spends hours per week here; the interface must become _more_ comfortable with use, not merely tolerable:

- **Spatial stability:** actions, filters, and statuses live in the same place on every page; nothing repositions between visits beyond the documented responsive reflow (§10).
- **Muscle memory:** keyboard shortcuts on the highest-frequency loop (Approvals), consistent button order (destructive left, primary right), consistent Esc/Enter semantics in every dialog.
- **Progressive quieting:** onboarding scaffolds (setup checklist, explanatory empty states) disappear permanently once outgrown — the experienced user's screen is quieter than the novice's.
- **No relearning:** components behave identically everywhere they appear; a pattern learned once is learned for the whole product.

---

## Visual Identity

> **Status: Direction A — The Reading Room — approved (2026-07-06), implemented (Phase 1).** This section records the exploration that led to that decision; it is kept as the rationale of record. The approved direction's concrete form (typefaces, palette, spacing, surfaces, motion, density and preview modes) is defined in §6, which supersedes the earlier placeholder tokens and `VISUAL_DIRECTION.md`. The tokens in §6 are live in `app/globals.css` (`@theme`), with Literata and Source Sans 3 loaded in `app/layout.tsx`.

### How these directions were derived

No direction below is taken from, or measured against, any existing product. Each is derived from the product itself. The product does one thing: **it lets a small team delegate content creation to an AI, judge the results, and trust the machine to publish for their company.** That sentence contains four distinct centers of gravity, and each one, taken as the organizing truth of the interface, produces a different visual identity:

| Center of gravity                     | Organizing truth                                     | Direction                |
| ------------------------------------- | ---------------------------------------------------- | ------------------------ |
| The **text being judged**             | The work is reading and deciding                     | A — The Reading Room     |
| The **pipeline doing the publishing** | The work is supervising an automated system          | B — The Instrument Panel |
| The **person delegating their voice** | The work is an act of trust that must feel safe      | C — The Soft Studio      |
| The **published artifact**            | The work is judging what the world will actually see | D — The Proof Table      |

All four directions honor the Design Philosophy's non-negotiables — these are invariants, not differentiators:

- One canonical status→color language; color appears only where it carries meaning.
- One primary action per screen; hierarchy from spacing, typography, grouping, proportion.
- No gradients, no decorative motion; functional animation ≤250ms.
- Full first-class legibility in **both English and Bulgarian** — whatever typography a direction implies must have complete, well-drawn Cyrillic.

Where the directions genuinely differ: contrast strategy, default density, shape language, typographic temperature, and **where visual richness is spent**.

---

### Direction A — The Reading Room

**Organizing truth:** the user's most frequent and highest-stakes act is reading AI-drafted text and deciding whether it may speak for their company. The interface is built for sustained, comfortable reading and fast typographic judgment; everything that is not the text steps back.

**Visual character (principle level, not tokens):**

- Typography does almost all the work: a deliberate, wide type scale; generous line-height and a bounded reading measure wherever post text appears; hierarchy expressed through size, weight, and spacing — rarely through color or boxes.
- A near-monochrome surface world: background and text tones in close, quiet steps; borders hairline or absent; whitespace is the container.
- The color budget is spent almost entirely on the status language. A status badge is often the only chromatic element in view — which makes state impossible to miss.
- Minimal shape language: small radii, essentially no elevation except a single subtle level for overlays.
- Low density by default; tables and queues tighten rhythm but keep the same typographic roles.

**Emotions it creates:** quiet concentration, seriousness, editorial care — the sense that the product respects both the text and the reader's judgment.

**Users it serves best:** the habitual weekly reviewer reading 10–30 drafts in one sitting; owners who care about their brand's voice; anyone running the 15-minute approval loop.

**Advantages:**

- Best reading ergonomics of the four → fastest judging on the hottest path.
- Ages best: typographic order does not date; there is almost nothing fashionable to expire.
- Fewest visual variables → cheapest to govern, hardest to erode PR by PR, easiest to hold consistent in a token system.
- Status colors gain maximum signal against a quiet ground — the Confidence mechanisms get louder, not quieter.
- Recognizability comes from typographic structure, exactly matching "identity from structure, not decoration."

**Disadvantages:**

- Demands excellent typographic execution; with mediocre type it reads plain rather than refined. Typeface selection (including Cyrillic) becomes the single most consequential decision.
- Data-heavy screens (admin tables, Activity, cron history) need a deliberately specified compact mode, or "airy" becomes "endless scrolling."
- Low visual excitement in isolation — it photographs quietly.
- Whitespace discipline is easy to erode without token-level enforcement.

**The five questions:** Q1 (easier to use) — strong: reading _is_ the use. Q2 (cognitive load) — strong: the fewest simultaneous visual variables. Q3 (scanability) — strong for text; moderate for dense data until the compact table mode is specified. Q4 (trust the AI) — strong, indirectly: a serious frame makes the AI's words feel considered, and status salience powers the transparency mechanisms. Q5 (work faster) — strong on the highest-frequency loop.

**Calm · Confidence · Focus:** Calm — strongest of the four: a quiet ground where nothing competes. Confidence — strong, earned soberly through precision and status salience rather than display. Focus — strong: one column, one action, text first.

---

### Direction B — The Instrument Panel

**Organizing truth:** the product is an automated system operating on the user's behalf, and the interface is its control surface. Making the machinery visible and exact is what earns trust.

**Visual character:**

- State-first composition: statuses, timestamps, counts, and schedules receive first-class visual treatment — system facts are rendered in a distinct "readout" style, always distinguishable from prose.
- Higher default density: aligned columns, compact rows, a perceivable underlying grid.
- Grouping carried by structural lines (rules, separators) more than by whitespace.
- A restrained, cooler, more technical neutral range; status color used more frequently because every row states itself.
- Compact, uniform controls; strictly systematic iconography.

**Emotions it creates:** mastery, oversight, exactness — "I can see everything the machine is doing."

**Users it serves best:** the supervisor persona — owners of fully-automated companies who mostly monitor; global admins; power users who live in the Posts and Activity tables.

**Advantages:**

- The most direct expression of trust-through-transparency: the Confidence mechanisms _are_ the identity, not an overlay.
- Excellent scanability of state; dashboards, queues, and cron history feel native.
- Dense admin surfaces need no special accommodation — density is the default.
- Precision cues (exact timestamps, exact counts) have a natural, dignified home.

**Disadvantages:**

- The hottest loop is the one it serves least: reading long drafts inside a dense readout world is measurably worse.
- Calm is at structural risk: lines + density + frequent color produce a busier ground that must be actively fought.
- Reads as demanding to non-technical users; the small-business owner delegating their voice may feel they've been handed a cockpit.
- The most visual variables to govern — highest long-term consistency cost.

**The five questions:** Q1 — moderate: excellent for monitoring, worse for reading. Q2 — moderate: density externalizes load onto the eye. Q3 — strong for state, weak for prose. Q4 — strongest of the four. Q5 — strong for supervision, moderate for review.

**Calm · Confidence · Focus:** Calm — weakest of the four. Confidence — strongest. Focus — moderate: many simultaneous readouts legitimately compete for attention.

---

### Direction C — The Soft Studio

**Organizing truth:** handing your public voice to a machine is an act of anxiety; the interface should feel like a friendly workroom that lowers the threshold to trying, judging, and shipping.

**Visual character:**

- Soft contrast: warm neutrals, gentle elevation (subtle shadows) instead of lines; larger radii; roomy, forgiving controls.
- The mid-density card as the universal container; forms feel conversational.
- Status colors slightly warmed and desaturated — stating without alarming; success given friendly weight.
- Typography chosen for friendliness and legibility over character; hierarchy in comfortable, unthreatening steps.

**Emotions it creates:** welcome, safety, low stakes — "this is easy; nothing here will bite."

**Users it serves best:** first-time and non-technical users; the onboarding journey; occasional (less-than-weekly) users who never build muscle memory.

**Advantages:**

- Lowest intimidation for a product that asks for real trust before showing value.
- Onboarding scaffolds, checklists, and teaching empty states feel native rather than bolted on.
- Forgiving: imperfect content density or uneven data looks acceptable on soft surfaces.

**Disadvantages:**

- Soft contrast works _against_ the philosophy's precision mechanism: "exact timestamps, exact counts, unambiguous wording" reads mushier in a soft world. This is the only direction whose character conflicts with a stated Confidence mechanism.
- Elevated cards multiply visual layers, straining Principle 11 (whitespace over boxes).
- Ages fastest: roundness and shadow conventions are fashion, and fashion cycles — it fails the five-year test soonest.
- Least distinctive: strip the logo and the structural identity must do all the work, because the styling is, by design, unassertive.
- Comfort is not confidence. A reassuring surface without visible machinery risks "pleasant" where the product needs "trustworthy."

**The five questions:** Q1 — strong for novices, neutral for the habitual user the product is designed for. Q2 — moderate: the tone soothes but the layered surfaces add noise. Q3 — weakest: low contrast is the enemy of scanning. Q4 — mixed: approachable, but approachability is not authority. Q5 — weakest on the hot loop.

**Calm · Confidence · Focus:** Calm — strong, but sedative rather than structural: calm from softness, not from order. Confidence — weakest. Focus — moderate.

---

### Direction D — The Proof Table

**Organizing truth:** an approval is a judgment about how the post will appear in the world; therefore show the work exactly as the world will see it, and make everything else disappear.

**Visual character:**

- A hard figure–ground split, enforced by rule: **the work** (post text + media rendered channel-faithfully — character limits, crop, hashtag placement as each network will show them) is the only rich object on screen; **the tools** (chrome, actions, filters) are maximally recessive, flat, and uniform.
- Two visual registers, never mixed: the artifact may carry the channel's shapes; the surrounding UI is quiet to the point of plainness.
- Near-monochrome chrome; even status color sits small and precise in the tool register.
- The artifact is centered; actions orbit it in a fixed position, building muscle memory around the object of judgment.

**Emotions it creates:** consequence, finality, editorial responsibility — "this is exactly what will go out under our name."

**Users it serves best:** careful approvers; brand-sensitive owners; multichannel teams where the same draft renders differently on Facebook, LinkedIn, Instagram, and TikTok and the difference matters.

**Advantages:**

- The strongest possible trust mechanism _at the moment of judgment_: users trust what they can see verbatim. Approve-then-surprised regret disappears.
- Makes channel constraints tangible instead of abstract (a truncation is _seen_, not warned about).
- The figure–ground register split is a genuinely distinctive identity mechanism.

**Disadvantages:**

- The identity collapses on artifact-less surfaces. Dashboard, Settings, Sources, Team, and all of Admin have no proof to show — roughly half the product's screens fall back to "very plain UI" with no identity of their own.
- Channel-faithful rendering is a permanent maintenance liability: networks change their presentation, and the previews must chase them. Rendering another platform's look also sits uneasily beside a philosophy that imitates nothing.
- Heavier per-card rendering slows the rapid keyboard queue that §3.8 promises.
- On inspection, "show the artifact faithfully" is a **component behavior** (a preview mode of `PostCard`), not a whole-product identity.

**The five questions:** Q1 — strong at approval, weak everywhere else. Q2 — strong: seeing the final form removes mental simulation. Q3 — moderate. Q4 — strongest at the moment of judgment, silent elsewhere. Q5 — mixed: fewer downstream rejects, slower queue throughput now.

**Calm · Confidence · Focus:** Calm — strong. Confidence — strong at approval, absent on non-artifact surfaces. Focus — strongest of the four at approval: literally one object on screen.

---

### Objective comparison

Ratings: ●●● strong · ●● adequate · ● weak. Judged against the philosophy's own tests, across the _whole_ product (all twelve page types in §4), for the habitual user it is designed for.

| Criterion                                         | A — Reading Room | B — Instrument Panel | C — Soft Studio | D — Proof Table |
| ------------------------------------------------- | :--------------: | :------------------: | :-------------: | :-------------: |
| Q1 Easier to use                                  |       ●●●        |          ●●          |       ●●        |       ●●        |
| Q2 Reduces cognitive load                         |       ●●●        |          ●●          |       ●●        |       ●●●       |
| Q3 Easier to scan                                 |       ●●●        |          ●●          |        ●        |       ●●        |
| Q4 Builds trust in the AI                         |        ●●        |         ●●●          |        ●        |       ●●●       |
| Q5 Faster work                                    |       ●●●        |          ●●          |        ●        |       ●●        |
| Calm                                              |       ●●●        |          ●           |       ●●        |       ●●●       |
| Confidence                                        |        ●●        |         ●●●          |        ●        |       ●●        |
| Focus                                             |       ●●●        |          ●●          |       ●●        |       ●●●       |
| Timelessness (five-year test)                     |       ●●●        |          ●●          |        ●        |       ●●        |
| Whole-product coverage (identity on every screen) |       ●●●        |         ●●●          |       ●●●       |        ●        |
| Habitual-use fit (hours/week user)                |       ●●●        |          ●●          |        ●        |       ●●        |
| Governance cost (keeping it consistent for years) |       ●●●        |          ●           |       ●●        |       ●●        |

**What the comparison shows:**

1. **A and B are mirror images.** A optimizes the _judging_ act; B optimizes the _supervising_ act. The product's own usage math breaks the tie: judging text is where the user's attention-minutes go (the <15-minute weekly review is the product's core promise), while supervision is glance-based — a dashboard visit, a badge check. An identity should be built for where attention dwells, and here attention dwells in reading.
2. **C is the only direction that conflicts with the philosophy** rather than merely emphasizing part of it: soft contrast structurally undermines the stated precision mechanism of Confidence. Its calm is decorative — produced by softness — where the philosophy demands calm produced by order.
3. **D's core insight is correct but mis-sized.** "Judge the artifact as it will appear" is a component behavior, not an identity: it can (and should) live inside any winning direction as `PostCard`'s channel-preview mode. As a whole-product identity it covers only the screens that have an artifact.
4. **Only A and B style every screen with equal conviction** — and between them, A carries the lower long-term governance cost and the stronger Calm and Focus, at the price of a weaker (but recoverable) Confidence score.

---

### Recommendation — Direction A: The Reading Room

**Direction A is the strongest long-term choice**, for five reasons:

1. **It aims where attention actually goes.** The majority of user attention-minutes are spent reading AI-drafted text and deciding. A direction that makes reading effortless wins Q2, Q3, and Q5 on the exact loop the product promises to make fast.
2. **It is the most timeless.** Typographic order does not date; density fashions, softness fashions, and readout aesthetics all do. A is the only direction with essentially nothing that could fail the five-year test.
3. **It makes the philosophy's mechanisms load-bearing.** On a quiet, near-monochrome ground, the canonical status colors become the loudest thing on screen (Confidence), whitespace grouping is native rather than imposed (Calm), and one-column-one-action is the natural composition (Focus). The other directions implement the philosophy; A _is_ the philosophy given form.
4. **It is the cheapest identity to keep.** Fewest visual variables, lowest governance cost, hardest to erode. For a product maintained for years by small teams, consistency-by-construction beats consistency-by-vigilance.
5. **It absorbs the rivals' truths without their costs.** B's contribution — precise, distinguishable rendering of system facts — becomes a defined _data role_ in A's typographic system (the philosophy already mandates precision cues). D's contribution — artifact fidelity — becomes `PostCard`'s channel-preview mode in §7, available wherever a post is judged. C's contribution — a gentle first hour — is delivered by Principles 8 and 9 (teaching empty states, setup checklist, progressive quieting) rather than by softening every surface for the veteran.

**Named risks, with mitigations:**

- _Typography must be excellent, in two alphabets._ Typeface selection becomes the single most consequential token decision; candidates are evaluated in English and Bulgarian side by side before anything else is chosen.
- _Dense data screens must be specified, not improvised._ A compact table/queue mode (tightened rhythm, same typographic roles) is defined in §6 tokens so Admin, Activity, and cron history are first-class citizens of the identity.
- _Whitespace discipline erodes by default._ Spacing is enforced through tokens and the PR checks in §12 — never through taste.

**Direction A was approved on 2026-07-06 and implemented in Phase 1.** Its concrete form — typefaces with full Cyrillic coverage, palette, status colors, spacing, surfaces, controls, motion, the compact density mode, and the artifact preview mode — is defined in §6. `VISUAL_DIRECTION.md` is formally superseded. The identity is in place across the app; what remains is applying it to surfaces that have not yet been rebuilt (Phases 4–7).

---

## 1. Product Design Principles

Every screen, present and future, must satisfy all of these — they are the operational form of the Design Philosophy above. Reviewers should reject PRs that violate them.

1. **Every page has exactly one job.** A page answers one question or completes one task. The current company page (brand + members + Buffer + channels + sources + posts on one scroll) violates this; the redesign splits it. If a page needs a second job, it needs a second page or a tab.
2. **One primary action per screen.** Exactly one solid/primary button visible at a time. Everything else is secondary (outline), tertiary (ghost/text), or in an overflow menu.
3. **Setup and daily work never share a surface.** Configuration (brand, channels, Buffer, sources, team) lives under _Settings_. Daily work (review, approve, publish, media) lives in the workspace tabs. A user doing their weekly 15-minute review must never scroll past a settings form.
4. **Work queues come to the user; the user never hunts for work.** Pending approvals, failed publishes, and disconnected integrations surface on the Dashboard and as badges in navigation — the user should not need to remember to check a page.
5. **Status is always glanceable.** Every post, source, channel, and cron run shows its state as a colored `StatusBadge` with a consistent color language app-wide. The same status never has two different colors on two pages.
6. **Progressive disclosure over long forms.** Show the 20% of fields used 80% of the time; collapse the rest behind "Advanced" or a secondary step. No form over ~7 visible fields without grouping.
7. **Above the fold = decision-ready.** On any queue or list page the first screenful must contain enough information to act (approve, retry, open) without scrolling or clicking through.
8. **Empty states teach the next step.** Every empty list explains what the feature does in one sentence and offers the single action that fills it. No dead ends: an empty approval queue links to generation; an empty gallery offers upload.
9. **Progress before configuration.** Onboarding shows a visible setup checklist (connect Buffer → configure a channel → add a source → generate) rather than dropping the user into empty forms.
10. **Destructive and irreversible actions always confirm — nothing else does.** Delete, disconnect Buffer, remove member, reject with notes: `ConfirmDialog`. Approve, save, edit: instant with toast + undo where the domain allows.
11. **Whitespace is the grouping mechanism; borders are the exception.** Prefer spacing scale + subtle background shifts over boxes-in-boxes. Max one level of card nesting.
12. **Text is the interface.** Prefer clear labels and short sentences over icons alone. Icons always accompany text except in universally understood spots (close ×, overflow ⋯).
13. **Never block the page for a section.** Server-render what is instant; skeleton only the slow region. Full-page spinners are banned.
14. **The system speaks in the user's language and vocabulary.** All strings via `next-intl` (EN/BG). Domain words are consistent: "Approve", "Reject", "Publish", "Channel", "Source" — never synonyms.
15. **Keyboard and screen reader parity.** Anything clickable is focusable, actionable with Enter/Space, and labeled. Queues support j/k-style traversal (see §11).

---

## 2. Information Architecture

### 2.1 The core IA problem being fixed

**As diagnosed in v1.0:** the app had (a) a flat global sidebar with four permanently disabled placeholder links, (b) a company page that was a single ~7-section scroll mixing setup and daily work, and (c) daily-work pages (approval, media, audit log) reachable only through module cards buried at the _bottom_ of that scroll.

**As it stands in v2.0:** (a) is fixed — the sidebar is Dashboard / Companies / Admin with no disabled links. (b) and (c) are not, and a fourth problem was introduced by the partial fix:

| #   | Problem                                           | Evidence                                                                                                                                                                                                  |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Three navigation layers for the same destinations | Sidebar (2 items) → workspace tab bar (8 tabs) → Overview module grid (6 cards). Posts is reachable three ways.                                                                                           |
| 2   | One tab bar, two mechanics                        | `overview·posts·sources·team·settings` are `?tab=`; `approval·media·audit-log` are routes.                                                                                                                |
| 3   | The monolith survived                             | `app/(dashboard)/companies/[slug]/page.tsx` — 501 lines, five tabs, seven nullable bindings, four sequential `if (activeTab === …)` blocks.                                                               |
| 4   | Settings never split                              | §2.4's five sub-pages are three stacked `Section`s (Brand · Integrations · Channels) inside that page.                                                                                                    |
| 5   | Approval implemented twice — ✅ **fixed in 4c**   | `/approval` rendered `ApprovalQueueSection`; the Posts tab rendered `GeneratedPostsSection`. Same data, same actions, two UIs. The queue is now a filter on Posts and the duplicate component is deleted. |
| 6   | Team is a tab, not a Settings page                | Contradicts §2.2. Team is rare-touch configuration and belongs under Settings.                                                                                                                            |

The direction is unchanged: **the company becomes a workspace with tabs; setup moves into a Settings area inside that workspace; the global sidebar shrinks to what is truly global.** What changed is that finishing now also means _undoing_ rows 1, 2, 5 and 6 — they are divergences to correct, not progress to preserve.

### 2.2 Top-level structure

Status markers: ✅ shipped as specified · ⚠️ shipped divergently · ⬜ not built.

```
Global shell (persistent left sidebar, 240px)                        ✅
├── Dashboard                  → /dashboard          "what needs my attention"
├── Companies                  → /companies          switch / create workspaces
├── ── divider ──
├── Admin (global admins only) → /admin              users · companies · LLM
└── Footer: user menu (name, email, language EN/BG, log out)

Company workspace (opened from Companies; header + horizontal tabs)
/companies/[slug]
├── Overview     (default tab)      health, setup checklist, this week      ⚠️ ?tab=, module grid
├── /posts                          all posts, filterable, full lifecycle   ✅
│                                   incl. the approval queue as a filter
│                                   (?status=pending_approval) + badge count
├── /media                          gallery: uploads + AI generations       ✅
├── /sources                        content sources + feed items/ingestion  ⚠️ ?tab=sources
├── /activity                       audit log timeline                      ⚠️ at /audit-log
└── /settings                       setup: everything configuration         ⬜ not split
    ├── General        name, website, default language, automation mode, danger zone
    ├── Brand          brand guidelines form
    ├── Channels       per-channel configs (FB/LI/IG/TT) + content mix quotas
    ├── Buffer         OAuth connection, profiles, disconnect + analytics API key
    └── Team           members, invites, roles                    ⚠️ currently ?tab=team
```

**Removed:** the disabled global "Posts / Media Gallery / Analytics / Settings" sidebar links. Placeholder navigation is worse than none — it teaches users that the nav lies. _(Shipped — the sidebar has contained only real links since Phase 2.)_

**No Analytics tab.** v1.0 deferred analytics to "Phase 9", which §12 never defined — an unresolved thread now closed. Post metrics shipped in v2-7 and live **inline on published post cards** (§4.5), not on a page of their own. A tab holding four numbers per post would re-create the module-card problem this IA exists to remove. Analytics earns a tab when it answers a question a user cannot answer from the post list — cross-post trends over time — and not before. See §2.6.

### 2.3 Rationale for each decision

| Decision                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global sidebar has only Dashboard, Companies, Admin                    | Posts, media, sources are company-scoped resources — a global "Posts" link would force a company picker anyway. Keeping the global level tiny makes the mental model unambiguous: _global = across companies, workspace = inside one._                                                                                                                                                                                                                                             |
| Company uses horizontal tabs, not a second sidebar                     | Two sidebars (global + company) waste horizontal space and create "which nav am I in?" confusion. Tabs under a persistent company header keep company identity visible and match GitHub's repo model — a familiar pattern for one-entity-many-facets.                                                                                                                                                                                                                              |
| Overview is the default tab                                            | Daily users land on status, not settings or a raw post list. Overview routes them: pending approvals → Posts filtered to Pending approval, setup incomplete → checklist → Settings.                                                                                                                                                                                                                                                                                                |
| Approvals is a filter on Posts, not a tab _(v2.1, reversed)_           | **Reverses the v2.0 decision.** The original argument — "burying it one filter deep adds a click to the hottest path" — priced the click but not the duplication: the queue and the Posts tab rendered the same posts from the same service through two UIs (§2.1 row 5), so every card change had two homes and could drift. One filter click is cheaper than one wrong card. The count badge, which was the tab's real contribution, moved to the Posts tab and survives (§9.1). |
| Settings groups five sub-pages                                         | Brand (36-field-capacity form), channels (4 config cards), Buffer, and team are all _rarely touched after onboarding_. Grouping them keeps daily surfaces clean (Principle 3) and gives each form room (Principle 1).                                                                                                                                                                                                                                                              |
| "Audit log" renamed to "Activity"                                      | Plain language; "audit log" is compliance vocabulary. Functionality unchanged.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Admin stays a global sidebar item, visually separated                  | It is cross-company by definition and gated by `isGlobalAdmin`. A divider + section label prevents editors from ever seeing it.                                                                                                                                                                                                                                                                                                                                                    |
| Content mix lives in Settings → Channels, not Sources _(v2.0)_         | A mix is a weekly _quota policy_ ("5 posts/week from this feed, 2 from company mission"), set once at setup and rarely revisited. Sources is a daily-work-adjacent list you fetch and debug. Putting a policy form on an operational page repeats the setup/daily-work blend this IA removes. It sits under Channels because the quota it divides is the per-channel cadence.                                                                                                      |
| Post metrics render inline on post cards, with no tab _(v2.0)_         | Metrics answer "how did this post do?" — a question about a post the user is already looking at. A separate page forces re-navigation to the same object. Only a cross-post question would justify its own surface.                                                                                                                                                                                                                                                                |
| The Buffer analytics key lives in Settings → Buffer _(v2.0)_           | It is a second Buffer credential (Personal API Key) with its own lifecycle — next to the OAuth connection it depends on, but in its own card, so removing it never reads as breaking publishing.                                                                                                                                                                                                                                                                                   |
| The post status filter is 5 choices over 7 statuses _(v2.1)_           | The grid's question is "where is this in the workflow?", not "what enum is this?" — the StatusBadge already answers the second. The fifth choice, Pending approval, exists because the filter absorbed the Approvals tab's job. Grouping and rationale in §4.5.                                                                                                                                                                                                                    |
| Danger zone (delete company) lives at the bottom of Settings → General | Standard placement (GitHub/Vercel); destructive actions are findable but never adjacent to daily actions.                                                                                                                                                                                                                                                                                                                                                                          |

### 2.4 Settings hierarchy detail

Settings uses a **left sub-navigation within the tab content area** (not nested tabs) on desktop; a select dropdown on mobile:

```
Settings
├── General   — company name, slug (read-only), website, default language,
│               automation mode (semi/fully automated) with explanation,
│               Danger zone: delete company (owner/admin only)
├── Brand     — logo, colors, fonts, tones, forbidden words, audience, competitors
├── Channels  — one expandable config card per channel (enable, Buffer profile,
│               posting language, cadence, windows, image rule, auto-image,
│               hashtag style, automation override)
│            — Content mix (v2-8): weekly quota per source + company-mission
│               quota, with a running total against channel cadence
├── Buffer    — connection status card, connect/reconnect (OAuth), profile list,
│               disconnect (confirm)
│            — Analytics key (v2-7): separate Personal API Key card —
│               add / replace / remove, last4 + added date, validation state
└── Team      — member table (name, email, role, joined), invite form,
                change role, remove (confirm)
```

Order = onboarding order: General → Brand → Channels needs Buffer → Buffer → Team is optional. The setup checklist (Overview) deep-links into each.

**Content mix placement (v2.0).** The mix distributes a weekly budget across content sources plus a company-mission quota (`Company.companyContentPostsPerWeek` and `ContentSource.postsPerWeek`). It renders as a section _below_ the channel cards, not inside one — it is company-wide, not per-channel — and stays hidden until at least one source exists, since there is nothing to distribute otherwise. Note the domain rule the UI must respect: `NULL` and `0` are different. `NULL` means "no quota configured" (legacy pooling behavior); `0` means "no mission posts". A numeric input that coerces empty to zero would silently change behavior, so the field needs an explicit "not set" state.

**Analytics key placement (v2.0).** Two Buffer credentials, two cards, one sub-page. The OAuth connection publishes; the Personal API Key reads metrics. The key card must state that removing it stops metrics collection and nothing else. It is owner-scoped: the status service returns `FORBIDDEN` to editors, which the UI must render as "only owners can manage this key" — **not** as "not configured" (the current behavior, and a bug: it misreports a permission state as a setup state).

### 2.5 Dashboard hierarchy (global)

The Dashboard is cross-company and operational (full spec in §8). Hierarchy top-to-bottom = urgency order:

1. **Needs attention** — pending approvals per company, failed publishes, disconnected Buffer
2. **Upcoming** — next scheduled/sent posts across companies (48h window)
3. **Automation activity** — recent cron outcomes in plain language
4. **Companies strip** — quick-switch cards with per-company counts

_Shipped state:_ the dashboard currently renders a 3-stat row (companies / pending / drafts), a setup-needed list, a pending-work list, a recent-activity feed, and a per-user LLM preference card. Blocks 2 and 3 above do not exist yet, and the companies strip is a text link. See §12 Phase 3.

### 2.6 Features added after v1.0 — where they live

Four features shipped between 2026-07-06 and 2026-07-20 with no entry in this spec. Each was placed by improvisation at build time; the placements below are the decided ones, and where they differ from what shipped, the shipped version is a divergence to correct.

| Feature                     | Shipped in | Data                                                               | Home in the IA                                                                       | Status                                                            |
| --------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Post analytics**          | v2-7       | `PostMetric`, `PostMetricSnapshot`, `MetricSyncStatus`             | Inline metrics strip on published post cards (§4.5); key in Settings → Buffer (§2.4) | ⚠️ metrics inline ✅, key under "Integrations" in the monolith    |
| **Content mix**             | v2-8       | `Company.companyContentPostsPerWeek`, `ContentSource.postsPerWeek` | Settings → Channels, below the channel cards (§2.4)                                  | ⚠️ currently under the Sources tab                                |
| **Post status filters**     | —          | `lib/posts/post-status-filter.ts`                                  | FilterBar on Posts, URL-synced via `?status=` (§4.5)                                 | ✅ five filters since 4c; needs restyle to `FilterBar` in Phase 5 |
| **Per-user LLM preference** | —          | `User.preferredLlmConfigId`                                        | User menu, not the dashboard (§2.7)                                                  | ⚠️ currently a card on the dashboard                              |

**Analytics: what the UI may and may not claim.** The metrics model carries a rule the design must not violate. `engagementRate` is Buffer's own figure, never derived by us, and its denominator differs by network (Facebook uses impressions, Instagram uses reach) — recorded in `engagementRateDenominator`. These are **not comparable across channels.** The UI labels the denominator and never presents a blended or cross-channel average. Metrics are also sparse by network: `impressions`/`clicks` are Facebook-only in observed data, `reach`/`views`/`saves`/`follows` Instagram-only. Every metric field is nullable — the strip renders only what exists and never shows `0` for "unknown". `MetricSyncStatus` distinguishes genuine states (not merely shades of error) and the UI must reflect that difference rather than collapsing them into "failed".

### 2.7 Per-user settings vs company settings

A distinction v1.0 did not need and the product now does. **Preferred LLM** (`User.preferredLlmConfigId`, `/api/v1/me/llm-preference`) is a personal preference that applies across every company the user belongs to — it is not company configuration and must not sit in a company's Settings, nor on the Dashboard, where it competes with operational content for the most valuable space on the busiest page.

It belongs in the **sidebar user menu**, alongside language and log out — the established home for "settings about me". It appears only when an admin has activated at least one LLM config, and disappears entirely otherwise rather than rendering an empty control.

---

## 3. User Flows

Notation: **Goal** → what success looks like · **Steps** as _User action_ ⇒ _System response_ · **Errors** with recovery.

### 3.1 First login

**Goal:** New user reaches a state where they understand what to do next in <1 minute.

1. User registers (name, email, password) ⇒ account created, redirected to `/login` with success banner "Account created — sign in".
2. User signs in ⇒ JWT session; redirect to `/dashboard`.
3. Dashboard detects zero companies ⇒ renders **first-run state** instead of the operational dashboard: product one-liner, 3-step illustration (Create company → Connect Buffer → Generate posts), single primary button **Create your first company**.
4. User clicks ⇒ `/companies/new`.

**Errors:** invalid credentials ⇒ inline alert above form, fields preserved; rate-limited ⇒ alert with retry-after wording; duplicate email at register ⇒ inline field error on email.

### 3.2 Create company

**Goal:** A company workspace exists and the user is inside it with a visible setup path.

1. From Dashboard first-run CTA or Companies → **New company** ⇒ `/companies/new`, a single short form: name (required), website (optional), default language (EN/BG), automation mode (radio cards: _Semi-automated — you approve every post_ pre-selected; _Fully automated — posts publish without review_).
2. Submit ⇒ company + owner membership created; redirect to `/companies/[slug]` (Overview tab).
3. Overview shows **Setup checklist** at top: ① Set brand guidelines ② Connect Buffer ③ Enable a channel ④ Add a content source ⑤ Generate your first posts — each row deep-links, completed rows check off live.

**Errors:** name taken/slug conflict ⇒ inline field error; validation ⇒ per-field Zod messages; server error ⇒ form-level alert, input preserved.

### 3.3 Configure company (General)

**Goal:** Owner adjusts name/website/language/automation mode.

1. Workspace → Settings → General ⇒ form pre-filled.
2. Edit fields → **Save changes** (button disabled until dirty) ⇒ PATCH; toast "Settings saved"; audit log entry.
3. Switching automation mode to _fully automated_ ⇒ inline callout before save: "New posts will be approved and published without review." (informational, not a blocking dialog).

**Errors:** forbidden (editor tries) ⇒ form rendered read-only with a note "Only owners can change settings", never a dead 403 page.

### 3.4 Connect Buffer

**Goal:** Company has a live Buffer connection and profiles mapped.

1. Settings → Buffer (or checklist deep-link) ⇒ connection card in _Not connected_ state, explanation line, primary **Connect Buffer**.
2. Click ⇒ OAuth redirect to Buffer (PKCE) ⇒ user authorizes ⇒ callback returns to Settings → Buffer with `?buffer=connected`.
3. Card flips to _Connected_ (green dot, Buffer user id, connected date); profile list loads (skeleton rows while fetching); banner: "Now map profiles in **Channels** →".

**Errors:** user denies OAuth ⇒ return with `?buffer=denied`, amber alert "Connection cancelled — no changes made"; token exchange fails ⇒ red alert with **Try again**; expired token later ⇒ card shows _Reconnect required_ state everywhere the connection is referenced (Channels page shows amber notice too).

### 3.5 Configure brand

**Goal:** Brand guidelines saved so generation respects voice.

1. Settings → Brand ⇒ form grouped into three sections with headers: **Identity** (logo upload, colors, fonts), **Voice** (tones multi-select, forbidden words tag input), **Context** (target audience textarea, competitors tag input). All optional — a persistent note says generation works without them but improves with them.
2. Logo upload ⇒ signed Cloudinary upload, thumbnail preview, replace/remove.
3. **Save changes** ⇒ PATCH, toast, checklist item ① completes.

**Errors:** oversized/wrong-type file ⇒ inline error under the dropzone before any upload; save failure ⇒ form-level alert, values preserved.

### 3.6 Configure content sources

**Goal:** At least one enabled source feeding items.

1. Workspace → **Sources** tab ⇒ list of source cards (name, type badge, enabled toggle, last fetched, item count) + primary **Add source**.
2. Add source ⇒ modal: type picker (RSS / Prompt / Product page / Calendar event) as radio cards, then type-specific fields (URL for RSS/product page, text for prompt, date+text for calendar).
3. Save ⇒ card appears; RSS/product-page cards show **Fetch now** action.
4. **Fetch now** ⇒ button enters loading state ⇒ result toast "12 new items" ⇒ card's item count and last-fetched update.
5. **Review fetched articles** _(v2.0)_ ⇒ expanding an RSS card lists its feed items, each with an enable/disable toggle. Disabling an item excludes it from generation without deleting it — the user curates what the AI may draw from. A source whose items are all disabled or consumed is "dry": it stays listed but is unpickable in the generate form, reading as "this feed has nothing new" rather than "this feed is gone".

**Errors:** unreachable/invalid feed URL ⇒ inline error in modal at validation, or error state on card after failed ingest with "Last fetch failed — Retry"; duplicate URL ⇒ inline field error.

### 3.6a Set the content mix _(v2.0, feature v2-8)_

**Goal:** The weekly post budget is distributed across sources deliberately rather than pooled.

1. Settings → **Channels** ⇒ below the channel cards, the **Content mix** section lists every enabled source with a posts-per-week number field, plus one row for **company mission** posts (written from brand knowledge, no article behind them).
2. A running total shows the weekly sum against the configured channel cadence, so over- and under-allocation are visible while typing rather than discovered later.
3. Save ⇒ `SaveBar`, toast.

**Rules the UI must honor:** an unset quota (`NULL`) and a zero quota are different states and must be distinguishable in the control — `NULL` means "not configured" and preserves legacy pooling, `0` means "none of these". The section is hidden entirely until at least one source exists.

**Errors:** a total exceeding the channel's weekly cadence is a warning, not a block — the mix is an intent, and the cron reconciles it.

### 3.7 Generate content

**Goal:** Draft posts exist for review.

Two paths, both preserved:

**Manual (on demand):**

1. Posts tab → primary **Generate post** ⇒ side panel (not modal — user may want to reference the list).
2. The panel shows **two controls by default**: channel select (enabled channels only) and content source. Everything else is behind a collapsed **Options** disclosure. _(v2.0 — the shipped form exposes five selects at once; see §12 Phase 5g.)_
   - **Content source** offers: _Company rules_ (brand knowledge), each RSS/product source (dry ones listed but disabled), and _Company mission_.
   - **Options** contains: content language (EN/BG), AI model (only when an admin has activated more than one), and source-link override (_Inherit / Include / Exclude_ — shown only when the selected source has feed items, since it governs whether the article URL appears in the post).
3. **Preview** ⇒ inline preview of generated text below the form (uses generate-preview endpoint), user can regenerate or tweak prompt. Duplicate-content and safety warnings surface here as inline `Alert`s _before_ the draft is created, with the similarity score and matched terms named.
4. **Create draft** ⇒ post created (`draft` or `pending_approval` per automation mode) ⇒ panel closes ⇒ new post appears at top of list highlighted for 2s.

**Why progressive disclosure here:** channel and source are the two decisions that change the output. Language follows the channel config, the model follows the user preference (§2.7), and the link override is meaningful for perhaps one generation in twenty. Presenting five equal selects makes the user weigh five decisions to perform one.

**Automatic (weekly cron):** no UI action; Overview "This week" section and Dashboard "Automation activity" show "Weekly schedule generated — 12 posts" after the cron run.

**Errors:** LLM provider failure ⇒ alert inside panel "Generation failed — provider error. Try again."; no enabled channels ⇒ panel replaced by empty-state pointing to Settings → Channels; safety-flagged output ⇒ post created with visible amber **Flagged** badge and reason on the card.

### 3.8 Approve posts

**Goal:** Reviewer clears the queue in minutes.

1. **Approvals** tab (badge shows count) ⇒ vertical queue of `ApprovalCard`s: channel chip, scheduled time, full text, media thumbnail, safety flag if any; filter bar (channel, date).
2. Per card: primary **Approve**, secondary **Reject**, tertiary **Edit**.
3. **Approve** ⇒ optimistic removal from queue, toast "Approved — will publish {time}" with **Undo** (calls reject-to-draft equivalent within toast lifetime if domain allows; otherwise toast without undo), badge count decrements.
4. **Edit** ⇒ modal with textarea, hashtag editor, image picker button, character counter against channel limit; save ⇒ new `PostVersion`, card content refreshes, stays in queue.
5. **Reject** ⇒ `ConfirmDialog` with optional notes textarea ⇒ post returns to `draft` with notes visible on its card in Posts tab.
6. Queue empty ⇒ success empty state: "All caught up 🎉" + link "View scheduled posts".

**Errors:** concurrent action (already approved elsewhere) ⇒ card resolves to error chip "Already handled — refresh", queue refetches; transition rejected by service ⇒ toast with server message, card restored.

### 3.9 Publish posts

**Goal:** Approved post reaches Buffer.

**Automatic:** cron sends `approved` posts scheduled within 48h ⇒ status `sent_to_buffer` ⇒ later `published`. User sees status change on Posts tab and Dashboard.
**Manual:** on an `approved` post card, overflow → **Publish now** ⇒ confirm dialog ("Send to Buffer immediately?") ⇒ loading state ⇒ status badge flips to `sent_to_buffer`, toast.

**Errors:** Buffer API failure ⇒ status `failed`, card shows red badge + `last_error` text + **Retry** action (respects retry_count max 3); token expired ⇒ error toast links to Settings → Buffer _Reconnect_.

### 3.9a Review post performance _(v2.0, feature v2-7)_

**Goal:** The user learns how a published post did, without leaving the post list.

1. **Setup (once):** Settings → Buffer → **Analytics key** card ⇒ owner pastes a Buffer Personal API Key ⇒ validated on save ⇒ card shows last4, added date, and validation state. Until this exists, published cards show no metrics strip and no error — the absence is the message, and the card explains where to enable it.
2. **Daily read:** published posts in the Posts tab carry a **metrics strip** below the content — only the metrics that network reports (reactions, comments, shares; plus impressions/clicks on Facebook, reach/views/saves/follows on Instagram). Absent metrics are omitted, never rendered as `0`.
3. **Engagement rate** is shown labeled with its denominator ("4.2% of impressions"), never as a bare percentage, and never averaged across channels.
4. **Sync now** ⇒ manual refresh for the company ⇒ loading state ⇒ toast with the count updated. Automatic sync runs on the cron.

**States:** metrics are per-post and each carries a `MetricSyncStatus`. These are genuinely different situations and get different treatment — never one generic "failed":

| Status                 | What it means                    | UI                                        |
| ---------------------- | -------------------------------- | ----------------------------------------- |
| synced                 | Metrics are current              | Strip renders                             |
| pending / never synced | Not fetched yet                  | Muted "Not yet synced"                    |
| not found              | Buffer has no record of the post | Quiet note; not an error the user can fix |
| unauthorized           | Key invalid or revoked           | Actionable alert → Settings → Buffer      |
| failed                 | Transient fetch failure          | "Couldn't load — Retry"                   |

**Roles:** metrics are visible to editors and owners alike. Only the _key_ is owner-managed; an editor sees the strip and a read-only note, never a "not configured" message that misattributes a permission limit to setup (§2.4).

### 3.10 Automation (fully automated mode)

**Goal:** Posts flow to Buffer with zero interaction; user retains oversight.

1. Owner sets mode in Settings → General (or per-channel override in Settings → Channels).
2. Cron: generates → auto-approves → sends. No approval badge accumulates for automated channels.
3. Oversight surfaces: Overview "This week" lists auto-published posts; Activity timeline records `post.auto_approved`, `post.sent`; Dashboard "Automation activity" summarizes runs; failures still escalate to "Needs attention".

**Errors:** cron run fails ⇒ Dashboard "Needs attention" row: "Automation run failed for {company} — {time}" linking to Activity; repeated Buffer failures ⇒ post `failed` after 3 retries, appears in "Needs attention".

### 3.11 Review history

**Goal:** Understand what happened to any post, or across the company.

1. **Post level:** any post card → overflow → **History** ⇒ modal with version list (v3, v2, v1: timestamp, editor, diff-style content preview) + actions timeline (generated → edited → approved → sent → published); versions offer **Restore** (confirm) which creates a new version.
2. **Company level:** **Activity** tab ⇒ reverse-chronological timeline grouped by day, icon per action type, actor, entity link; filter by action type.

**Errors:** restore on a post already `sent_to_buffer`/`published` ⇒ action hidden (invalid transition never offered).

### 3.12 Media management

**Goal:** Assets available for attaching to posts.

1. **Media** tab ⇒ responsive thumbnail grid; filter pills (All / Uploads / AI-generated); primary **Upload**, secondary **Generate with AI**.
2. Upload ⇒ dropzone modal (or drag anywhere onto grid) ⇒ progress per file ⇒ thumbnails appear.
3. Generate ⇒ modal with prompt pre-filled from brand colors/tone ⇒ loading (skeleton tile in grid) ⇒ asset saved with AI badge.
4. Asset click ⇒ detail modal: full preview, dimensions, source (upload/AI + prompt), **Delete** (confirm; warns if attached to posts).
5. **From a post** (edit modal / approval edit): **Image picker modal** with two tabs — _Gallery_ (grid, click to select) and _Generate_ (same AI form, result auto-selected) — selection sets `media_asset_id`.

**Errors:** upload type/size rejection ⇒ per-file inline error in modal; Leonardo/API failure ⇒ error state in modal with retry, no phantom tile; gallery cap (50) reached ⇒ upload disabled with explanatory note.

### 3.13 Admin workflow

**Goal:** Global admin manages users, companies, and the active LLM.

1. Sidebar → **Admin** ⇒ page with three tabs: **Users**, **Companies**, **LLM providers** (replaces one long stacked page).
2. Users: table (name, email, admin badge, companies count, created) + search.
3. Companies: table (name, owner, members, posts, mode, created) + search; row click → company workspace (admin bypasses membership).
4. LLM providers: list of provider rows (provider logo, model, base URL, **Active** badge on exactly one) + **Add configuration**; row actions: Activate (confirm — "Switch active provider to X?"), Edit, Delete (blocked with message if active).

**Errors:** deleting the active config ⇒ blocked with inline explanation "Activate another provider first"; invalid API key format ⇒ Zod inline error; activation failure ⇒ toast, state unchanged.

---

## 4. Page Specifications

Standard fields per page: Purpose · Primary action · Secondary actions · Visible / Hidden info · Layout & components · Priority hierarchy · Empty / Loading / Error states · Responsive · Accessibility. Shared behaviors (unless overridden): loading = skeleton of the content shape (never spinner-only), error = inline `Alert` with retry, all interactive elements keyboard-operable with visible focus ring.

### 4.1 Dashboard (`/dashboard`)

- **Purpose:** Answer "what needs my attention today?" across all companies.
- **Primary action:** Resolve the top attention item (contextual: "Review 4 posts", "Reconnect Buffer", "Retry publish").
- **Secondary:** New company; open a company.
- **Visible:** Needs-attention list (approvals count per company, failed publishes, disconnected Buffer, failed cron runs); upcoming posts (next 48h, cross-company); automation activity (last runs, plain-language); companies strip.
- **Hidden:** analytics, raw cron JSON, per-post detail (one click away), **personal settings such as preferred LLM** — these belong in the user menu (§2.7), not on the busiest operational surface.
- **Layout:** single 720–960px column; stacked sections in urgency order (§2.5). Components: `PageHeader`, `AttentionCard`, `PostCard` (compact) for upcoming, `ActivityTimeline` (compact), `CompanyCard` row.
- **Hierarchy:** attention > upcoming > activity > companies.
- **Empty:** zero companies ⇒ first-run state (§3.1.3). Companies but nothing pending ⇒ "All clear" hero line + upcoming + activity remain.
- **Loading:** skeleton rows per section, header instant.
- **Error:** per-section inline alert; other sections unaffected.
- **Responsive:** single column throughout; companies strip becomes vertical list <640px.
- **A11y:** attention items are links with full-sentence accessible names ("Review 4 pending posts for Acme").

### 4.2 Companies (`/companies`)

- **Purpose:** Switch between, or create, workspaces.
- **Primary:** **New company** (header-right).
- **Secondary:** open company (whole card clickable).
- **Visible per card:** name, role badge, automation mode, pending-approval count, Buffer status dot, member count.
- **Hidden:** settings detail, post lists.
- **Layout:** responsive card grid (3/2/1 cols); `PageHeader` + `CompanyCard` grid.
- **Empty:** EmptyState "Create your first company" (mirrors first-run).
- **Loading:** 6 skeleton cards. **Error:** page-level alert + retry.
- **A11y:** card is a single link (name as accessible name); badges have text, not color alone.

### 4.3 New company (`/companies/new`)

- **Purpose:** Create a workspace in <30s.
- **Primary:** **Create company** (disabled until name valid).
- **Secondary:** Cancel → back.
- **Visible:** name, website (optional), default language, automation mode as two radio cards with one-line consequences.
- **Layout:** centered 480px single-column form; no sidebar distraction beyond global shell.
- **Error:** inline Zod field errors; slug conflict on name field.
- **A11y:** radio cards are real radios (label wraps card); error text linked via `aria-describedby`.

### 4.4 Company Overview (`/companies/[slug]` — default tab)

- **Purpose:** Health check + router into work.
- **Primary:** contextual — setup incomplete ⇒ next checklist step; else **Review approvals (n)** if n>0; else **Generate post**.
- **Secondary:** links into every tab.
- **Visible:** setup checklist (until 5/5, then hidden permanently); stat row (pending approvals, scheduled this week, published this week, failed); "This week" list (next scheduled posts, compact); recent activity (last 5, link to Activity).
- **Hidden:** all forms; all configuration (moved to Settings).
- **Layout:** `CompanyHeader` (name, automation-mode badge, Buffer status dot) + `TabBar` + content: checklist card, `StatsCard` row ×4, two-column below (This week | Recent activity), stacking <1024px.
- **Empty:** new company ⇒ checklist dominates, stats row shows zeros muted.
- **Loading:** header + tabs instant (server-rendered), skeleton stat cards and list rows.
- **A11y:** stat cards are links to filtered views with descriptive names; checklist steps announce completion state.

### 4.5 Posts (`/companies/[slug]/posts`)

- **Purpose:** Browse and manage the full post lifecycle.
- **Primary:** **Generate post** (opens side panel, §3.7).
- **Secondary per row:** contextual by status — Edit / Submit for approval (draft) · Publish now (approved) · Retry (failed) · History, Delete in overflow.
- **Visible per row:** channel chip, status badge, first ~2 lines of content, scheduled time, media thumb, safety flag, rejection notes indicator; **metrics strip on published posts** (§3.9a).
- **Hidden:** full text, versions, audit (in detail/History modal); image controls and metrics detail behind row expansion.
- **Layout:** `FilterBar` + list of `PostCard` rows (list, not grid — text is the content) + side `GeneratePanel`.
- **Hierarchy:** filter bar > list; within a row: status + content > metadata > actions.
- **Empty:** no posts ⇒ "No posts yet — generate your first" + Generate CTA; filtered-empty ⇒ "No posts match" + Clear filters. These are different messages by design: the first asks for a post, the second says a filter is hiding posts that exist. **Third case (v2.1):** filtered-empty under _Pending approval_ is not a failed search — it is the end of the review loop, and gets the "All caught up" treatment §3.8 step 6 specifies, never "widen your filter".

**Status filter (v2.1).** Five choices cover all seven `PostStatus` values, URL-synced via `?status=` so a filtered view is shareable and survives reload. An unrecognized value falls back to `all` rather than rendering an empty grid the user cannot explain. Filtering is client-side over the loaded list — instant, no refetch.

Order is lifecycle order, left to right, so the bar reads as the workflow it filters.

| Filter               | Statuses                      | Why grouped this way                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All**              | all seven                     | Default                                                                                                                                                                                                                                                                |
| **Drafts**           | `draft`                       | Work nobody has been asked to look at yet. `rejected` is excluded: rejection does not reset a post to draft, so burying it here would hide an owner's decision.                                                                                                        |
| **Pending approval** | `pending_approval`            | The approval queue (§3.8). Split out from Drafts in v2.1 when this filter replaced the Approvals tab — the difference the v2.0 grouping dismissed as "only who is waiting" is precisely what this view exists to answer. The only filter with a count outside the bar. |
| **Approved**         | `approved`                    | Approval granted, nothing sent yet                                                                                                                                                                                                                                     |
| **Published**        | `sent_to_buffer`, `published` | "What went out." Once sent, a post has left the system for good. Matches the pair eligible for metrics. `failed` is excluded — publishing was attempted and did not happen.                                                                                            |

`rejected` and `failed` have no filter of their own and are reachable only under **All** — a documented gap, asserted by a test so it stays deliberate.

The groupings mirror boundaries the services already draw; they are not invented for the UI. `lib/posts/post-status-filter.ts` is the single source and is unit-tested — the design must not introduce a sixth grouping without changing that module.

**The count appears twice, from one predicate.** The Posts tab badge and the Pending-approval chip both read `FILTER_STATUSES.pending_approval`; the badge is server-rendered via `countPendingApprovals`, the chip counts the loaded list. A card action (approve / reject / submit) updates the list locally for instant feedback and calls `router.refresh()` to re-render the badge, so the two cannot drift (§9.4).

- **Loading:** 5 skeleton rows. **Error:** list-level alert + retry; row action errors as toasts.
- **Responsive:** row actions collapse into overflow menu <768px; generate panel becomes full-screen sheet.
- **A11y:** list = `role="list"`; status conveyed by badge text; overflow menu is a proper `menu` with arrow-key navigation.

### 4.6 Approvals — `/companies/[slug]/posts?status=pending_approval`

**No longer a page of its own (v2.1).** The queue is the Posts page under its Pending-approval filter; §4.5 governs the layout, and §3.8 still governs the flow. The two old URLs (`/approval`, `/approvals`) 308 here, both in one hop.

Requirements that were this section's and now bind §4.5 whenever the Pending-approval filter is active:

- **Primary:** **Approve** on the focused card. **Secondary:** Reject, Edit.
- **Visible:** full post text — reviewers must read what they are approving, so cards under this filter do not truncate.
- **Empty:** "All caught up" + link forward, never "no posts match" (§4.5).
- **Keyboard:** j/k move focus between cards, a approve, r reject, e edit (documented in a "?"-triggered shortcut sheet).
- **A11y:** each card an `article` labeled "Post for {channel}, scheduled {time}"; optimistic removal announced via `aria-live="polite"` ("Post approved, 3 remaining").

**Still outstanding after v2.1.** Phase 4c moved the queue and kept the actions working, but it did not rebuild the card: the keyboard loop, the no-truncation rule, the `aria-live` announcement, and the centered one-decision-at-a-time column are Phase 5's job (§12). The filter is the queue's new home, not yet its finished form.

### 4.7 Media (`/companies/[slug]/media`)

- **Purpose:** Manage the asset library.
- **Primary:** **Upload**. **Secondary:** Generate with AI; per-asset Delete (in detail modal).
- **Visible:** thumbnail grid, AI badge on generated assets, filter pills, asset count vs 50-cap.
- **Hidden:** dimensions, prompt, attachments (detail modal).
- **Layout:** actions row (`FilterBar` pills left, buttons right) + `MediaCard` grid (5/4/3/2 cols by breakpoint) + detail `Modal`.
- **Empty:** dropzone-style EmptyState ("Drag images here or Upload / Generate").
- **Loading:** skeleton tiles; AI generation shows one pulsing placeholder tile.
- **Error:** failed upload = inline per-file; failed load = alert + retry.
- **A11y:** tiles are buttons with alt-derived names ("AI image: sunset over…"); modal focus-trapped; delete confirms.

### 4.8 Sources (`/companies/[slug]/sources`)

- **Purpose:** Manage generation inputs.
- **Primary:** **Add source**. **Secondary per card:** enable/disable toggle, Fetch now (RSS/product), Edit, Delete (overflow).
- **Visible per card:** name, type badge, enabled state, last fetched, new-item count, last-fetch error if any; expandable **feed-item list** with per-item enable toggles (§3.6 step 5).
- **Hidden:** the content mix — it is quota policy and lives in Settings → Channels (§2.3). A link at the foot of the list points there ("Set how often each source posts →") so the relationship stays discoverable without putting the form here.
- **Layout:** `FilterBar` (type) optional + `SourceCard` list + add/edit `Modal` (§3.6).
- **Empty:** explains sources feed generation; CTA Add source.
- **Error:** per-card fetch-error state with Retry; form errors inline.
- **A11y:** toggle is a labeled switch announcing state; type conveyed by text badge.

### 4.9 Activity (`/companies/[slug]/activity`)

- **Purpose:** Chronological record of everything (audit log).
- **Primary:** none (read-only page — the exception to Principle 2; no button competes).
- **Secondary:** filter by action type; load more.
- **Visible:** day-grouped timeline — icon, action sentence ("Maria approved a LinkedIn post"), time, entity link.
- **Hidden:** raw metadata JSON (expandable per entry for admins/debugging).
- **Layout:** `FilterBar` + `ActivityTimeline`, 720px column.
- **Empty:** "Activity will appear here once the team starts working."
- **Loading:** skeleton timeline rows; pagination = "Load more" button (not infinite scroll — predictable for a log).
- **A11y:** timeline = list; times as `<time datetime>`; icons `aria-hidden` (sentence carries meaning).

### 4.10 Settings (five sub-pages, §2.4)

Common: left sub-nav (desktop) / select (mobile); each sub-page a single form region, max-width 640px; sticky **Save changes** bar appears only when dirty (Linear-style), with Discard; editors see read-only + note.

- **General:** fields per §3.3; Danger zone visually separated (red-tinted border card) at bottom: Delete company → `ConfirmDialog` requiring typed company name.
- **Brand:** three grouped sections (§3.5); tag inputs for words/competitors; `ColorField` rows; logo dropzone with preview.
- **Channels:** four `ChannelSettingsCard`s (Facebook, LinkedIn, Instagram, TikTok), collapsed to summary line (enabled?, profile, cadence) — expand to full form: enable toggle, Buffer profile select (disabled + hint if Buffer not connected), posting language, posts/day & week, posting windows editor (day-range + time-range rows, add/remove), image required toggle, **auto-image toggle** (generate an AI image at generation time — opt-in, since it spends image credits; independent of "image required", which only validates presence and never produces one), max length, hashtag style select, automation override select (Inherit / Semi / Fully). One card expanded at a time.
  Below the cards: **Content mix** (§3.6a) — per-source weekly quotas + company-mission quota with a running total. Hidden until ≥1 source exists.
- **Buffer:** two cards, one per credential.
  - `IntegrationCard` (OAuth — publishing) states: not-connected (explain + Connect) / connected (green dot, account, date, profile list, Disconnect in overflow with confirm) / reconnect-required (amber, Reconnect primary).
  - `AnalyticsKeyCard` (Personal API Key — metrics) states: not-configured (explain what it enables + Add key) / configured (last4, added date, last-validated, Replace / Remove) / invalid (amber, "Key rejected — replace it") / editor (read-only + "Only owners can manage this key"). Removing it confirms with body text stating that metrics stop and publishing is unaffected.
- **Team:** member table (avatar-initials, name, email, role select [owner-editable], joined, remove ×) + inline invite row (email + role + Invite). Cannot remove last owner — control disabled with tooltip.

### 4.11 Admin (`/admin`)

Per §3.13: page header "Administration" + 3 tabs (Users / Companies / LLM providers). Tables use the shared `DataTable` styles: sticky header row, search input top-right, 25/page pagination. LLM tab: `ProviderRow` list; exactly one Active badge enforced visually and by service. Empty/loading/error follow shared behaviors.

### 4.12 Auth pages (`/login`, `/register`, `/verify-email`)

Centered 400px card on a plain background, product wordmark above, no shell. Single primary button; link to the sibling page below. Language switcher bottom-center. Errors as `Alert` above the form. A11y: form labeled, autocomplete attributes set, error focus moved to alert.

**`/verify-email` (v2.0).** Same shell. Four states, each with exactly one action:

| State     | Message                  | Action                                  |
| --------- | ------------------------ | --------------------------------------- |
| Verifying | "Confirming your email…" | none (skeleton)                         |
| Success   | "Email confirmed"        | **Continue to dashboard**               |
| Expired   | Token past expiry        | **Resend confirmation**                 |
| Invalid   | Token unknown or used    | **Resend confirmation** + link to login |

Expired and invalid are separate messages: the first is the user's timing, the second suggests a bad link, and telling them apart determines whether "resend" will help. Post-registration, the register page routes here with a "check your inbox" state rather than a bare toast.

---

## 5. Wireframes (low-fidelity, structural)

### 5.1 Global shell + Dashboard

```
┌────────────┬──────────────────────────────────────────────────────┐
│  ◆ Logo    │  Dashboard                                           │
│            │  Good morning, Emili                                 │
│  Dashboard │ ──────────────────────────────────────────────────── │
│  Companies │  NEEDS ATTENTION                                     │
│            │  ┌──────────────────────────────────────────────┐    │
│ ────────── │  │ ● 4 posts awaiting approval — Acme   [Review]│    │
│  ADMIN     │  │ ● Publish failed (2 retries) — Beta  [Retry] │    │
│  Admin     │  │ ● Buffer disconnected — Acme     [Reconnect] │    │
│            │  └──────────────────────────────────────────────┘    │
│            │  UPCOMING (next 48h)                                 │
│            │  ├ in 3h   LinkedIn · Acme   "Launching our…"        │
│            │  ├ Tue 9:00 Facebook · Beta  "Meet the team…"        │
│            │  AUTOMATION ACTIVITY                                 │
│            │  ├ 06:00 Weekly schedule generated — Acme (12 posts) │
│            │  ├ 06:00 3 posts sent to Buffer — Beta               │
│ ────────── │  YOUR COMPANIES                          [+ New]     │
│ E. Stoyan… │  [ Acme · owner · 4 pending ] [ Beta · editor · ✓ ]  │
│ EN ▾  ⎋    │                                                      │
└────────────┴──────────────────────────────────────────────────────┘
```

### 5.2 Company workspace — Overview

```
┌ Companies / Acme ───────────────────────────────────────────────┐
│  Acme Corp   [Semi-automated]  ● Buffer connected               │
│──────────────────────────────────────────────────────────────── │
│  Overview | Posts (4) | Media | Sources | Activity | Settings   │
│──────────────────────────────────────────────────────────────── │
│  ┌ Setup 3/5 ──────────────────────────────────────────────┐    │
│  │ ✓ Brand  ✓ Buffer  ✓ Channel  ○ Add a source →  ○ Gen…  │    │
│  └──────────────────────────────────────────────────────────┘   │
│  [ 4 Pending ] [ 9 Scheduled ] [ 12 Published ] [ 1 Failed ]     │
│                                                                  │
│  THIS WEEK                        RECENT ACTIVITY                │
│  ├ Mon 9:00  LinkedIn  approved   ├ Maria approved a post        │
│  ├ Tue 12:00 Facebook  pending    ├ Schedule generated (12)      │
│  ├ Wed 9:00  Instagram approved   ├ Ivan edited a post           │
│  └ …                              └ View all →                   │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3 Posts

```
│ Overview | Posts (4) | Media | …                                 │
│───────────────────────────────────────────────────────────────── │
│ [All] [Drafts] [Pending approval ·4] [Approved] [Published]      │
│ [Channel ▾] [Date ▾]                           [Generate post]   │
│───────────────────────────────────────────────────────────────── │
│ ┌ [LinkedIn] [Approved]  Mon 9:00 ─────────────────────── ⋯ ┐    │
│ │ "We're excited to announce our new…"              [img]  │     │
│ └───────────────────────────────────────────────────────────┘    │
│ ┌ [Facebook] [Failed ·2/3] ── Retry ──────────────────── ⋯ ┐     │
│ │ "Meet the team behind…"   ⚠ Buffer error: rate limited   │     │
│ └───────────────────────────────────────────────────────────┘    │
│ ┌ [Instagram] [Draft] ⚑ flagged ─────────────────────── ⋯ ┐      │
│ └───────────────────────────────────────────────────────────┘    │
│                        [Load more]                               │
```

### 5.4 Approvals — the Pending filter on Posts

_(v2.1: the same page as §5.3 with `Pending approval` selected. The tab bar and
filter bar are §5.3's; the card treatment below is Phase 5's target form.)_

```
│ Overview | Posts (4) | Media | Sources | Activity | Settings     │
│───────────────────────────────────────────────────────────────── │
│ [All] [Drafts] [Pending approval ·4] [Approved] [Published]      │
│ [Channel ▾] [Date ▾]                                             │
│───────────────────────────────────────────────────────────────── │
│        ┌──────────────────────────────────────────────┐          │
│        │ [LinkedIn]              scheduled Mon 9:00   │          │
│        │                                              │          │
│        │ Full post text shown without truncation so   │          │
│        │ the reviewer can read everything…            │          │
│        │ #hashtag #another                            │          │
│        │ [ thumbnail ]                                │          │
│        │ ⚑ Safety: mentions competitor  (if flagged)  │          │
│        │──────────────────────────────────────────────│          │
│        │            [Edit]   [Reject]   [ Approve ]   │          │
│        └──────────────────────────────────────────────┘          │
│        ┌ next card … ┐                                           │
```

### 5.5 Media

```
│ (All) (Uploads) (AI)     37/50 assets   [Generate AI]  [Upload]  │
│───────────────────────────────────────────────────────────────── │
│  [img] [img] [img·AI] [img] [img]                                │
│  [img·AI] [img] [img] [img] [img]                                │
│                                                                  │
│  click tile → ┌ Detail modal: preview · 1200×628 · AI            │
│               │ prompt: "sunset, brand colors…"  [Delete]        │
```

### 5.6 Sources

```
│ Content sources                              [Add source]        │
│───────────────────────────────────────────────────────────────── │
│ ┌ Company blog        [RSS]      ● Enabled ──────────── ⋯ ┐      │
│ │ Last fetched 2h ago · 12 items            [Fetch now]  │       │
│ └──────────────────────────────────────────────────────────┘     │
│ ┌ Summer campaign     [Prompt]   ○ Disabled ──────────── ⋯ ┐     │
│ └──────────────────────────────────────────────────────────┘     │
│ ┌ Product page        [URL]      ● Enabled  ⚠ fetch failed │     │
│ │                                            [Retry]       │     │
│ └──────────────────────────────────────────────────────────┘     │
```

### 5.7 Settings (Channels shown)

```
│ Overview | Posts | … | Settings                                  │
│───────────────────────────────────────────────────────────────── │
│  General   │  Channels                                           │
│  Brand     │  ┌ Facebook   ● enabled · @acme · 5/wk ──── [▾] ┐   │
│ ▸Channels  │  └───────────────────────────────────────────────┘  │
│  Buffer    │  ┌ LinkedIn   ● enabled · @acme-co · 3/wk ─ [▴] ┐   │
│  Team      │  │ Buffer profile  [@acme-co ▾]                 │   │
│            │  │ Language [EN ▾]  Posts/day [1] Posts/wk [3]  │   │
│            │  │ Windows: Mon–Fri 9:00–11:00        [+ add]   │   │
│            │  │ ▸ Advanced (image rule, length, hashtags,    │   │
│            │  │   automation override)                       │   │
│            │  │                       [Discard] [Save]       │   │
│            │  └───────────────────────────────────────────────┘  │
│            │  ┌ Instagram  ○ disabled ──────────────────[▾] ┐    │
│            │  ┌ TikTok     ○ disabled ──────────────────[▾] ┐    │
```

### 5.8 Admin

```
│ Administration                                                   │
│  Users | Companies | LLM providers                               │
│───────────────────────────────────────────────────────────────── │
│  (LLM providers)                        [Add configuration]      │
│  ┌ Anthropic · claude-fable-5        [Active] ── Edit · ⋯ ┐      │
│  ┌ OpenAI · gpt-4o                    Activate · Edit · ⋯ ┐      │
│  ┌ Groq · llama-3.3-70b-versatile                      Activate · Edit · ⋯ ┐      │
```

---

## 6. Design System

**This section is the concrete form of the approved visual identity — Direction A, _The Reading Room_.** Implemented as Tailwind 4 `@theme` tokens in `app/globals.css`. Values below are the canonical tokens; components consume tokens only — no ad-hoc hex/px in component code.

**The loudness order** (governs every screen): **status colors** are the loudest visual elements, then the single ink primary action, then the accent (links, focus, active nav), then everything else. Nothing may outshout a status badge. This is why the primary button is ink rather than accent-colored, and why no other element may borrow the status hues.

### 6.1 Typography

The identity is typography-led: two faces, both chosen for editorial quality **and** first-class Cyrillic (complete `cyrillic` + `cyrillic-ext` coverage, real italics, Bulgarian `locl` letterforms).

| Role family                    | Face                                  | Why                                                                                                  |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Reading — titles and post text | **Literata** (variable, optical size) | Designed for sustained screen reading; genuine italics; excellent Cyrillic including Bulgarian forms |
| Working — all UI text          | **Source Sans 3** (variable)          | Quiet humanist sans; complete Cyrillic; tabular figures for the data role                            |

- Loaded via `next/font/google` with `subsets: ["latin", "cyrillic", "cyrillic-ext"]`, `display: "swap"`. Fallback stacks carry Cyrillic: `Georgia, serif` and `"Helvetica Neue", Arial, sans-serif`.
- **Geist is retired.** Its Cyrillic coverage is not first-class, and the identity requires equal quality in English and Bulgarian.
- **No third face.** The `data` role is Source Sans 3 with `font-variant-numeric: tabular-nums` — precise, quiet readouts without a terminal aesthetic.

**Type roles** — the only text styles permitted anywhere in the app:

| Token         | Face          | Size/line | Weight | Use                                                                                  |
| ------------- | ------------- | --------- | ------ | ------------------------------------------------------------------------------------ |
| `display`     | Literata      | 28/36     | 600    | Page title — exactly one per page                                                    |
| `title`       | Literata      | 20/28     | 600    | Section and card titles                                                              |
| `reading`     | Literata      | 17/28     | 400    | Post text in review/edit contexts — always the largest body-class text on its screen |
| `body`        | Source Sans 3 | 15/24     | 400    | Default UI text                                                                      |
| `body-strong` | Source Sans 3 | 15/24     | 600    | Emphasis, active states                                                              |
| `small`       | Source Sans 3 | 13/20     | 400    | Metadata, labels, help text                                                          |
| `data`        | Source Sans 3 | 13/20     | 500    | Timestamps, counts, IDs, schedules — `tabular-nums`, default color `fg-muted`        |
| `micro`       | Source Sans 3 | 12/16     | 600    | Overlines and badge text — uppercase, tracking +0.06em                               |

**Rules:**

- The serif never appears below 17px; the sans never above 15px (button labels 14px). This division of roles — serif for what is read and judged, sans for what is operated — is the recognizable core of the identity.
- **The post is the visual center.** Wherever a post is judged (Approvals, Posts, edit preview), its text renders in `reading` and everything around it in `small`/`data`. Dense operational information (timestamps, counts, run states) always uses the `data` role — quiet, muted, exact. This is token-enforced, not layout-improvised.
- Reading measure: `reading` blocks are capped at 68ch.
- No letter-spacing on lowercase text — tracking damages Cyrillic legibility. Tracking exists only in the uppercase `micro` role.
- Never synthesize italic or bold. Synthetic Cyrillic obliques are illegible; Literata's true italic is the only italic in the product.
- `<html lang="bg">` must be set for the Bulgarian locale so `locl` Bulgarian glyph variants activate.
- Every component tolerates Bulgarian strings running ~20% longer than English: truncate with full text on hover/focus, never overflow. Both locales are reviewed side by side for every new surface.

### 6.2 Color

A warm, near-monochrome world: ink on paper-toned neutrals. The chroma budget is spent almost entirely on the status language — a status badge is often the only saturated element in view, which is precisely what makes state impossible to miss.

| Token            | Light value | Use                                                                        |
| ---------------- | ----------- | -------------------------------------------------------------------------- |
| `bg`             | #FBFAF9     | App background — barely warm off-white                                     |
| `surface`        | #FFFFFF     | Cards, panels, modals, inputs                                              |
| `surface-subtle` | #F5F4F2     | Hovers, wells, table header band                                           |
| `border`         | #E9E7E4     | Hairlines — the default 1px border                                         |
| `border-strong`  | #D6D3CF     | Interactive-card hover, dividers that must be visible                      |
| `fg`             | #211E1B     | Ink — primary text and the primary button                                  |
| `fg-muted`       | #6E6A64     | Secondary text, the `data` role                                            |
| `fg-faint`       | #9B968F     | Placeholders and disabled states only — never for information              |
| `accent`         | #3E5C76     | Links, focus ring, active-nav indicator — never buttons, never backgrounds |

**Status palette** — the canonical status→color map, app-wide. Each status has a tint background, deep text (all pairs ≥ 4.5:1), and a dot color; `StatusBadge` resolves these internally — callers never pass colors:

| Status / state     | Variant | Tint bg | Text    | Dot     |
| ------------------ | ------- | ------- | ------- | ------- |
| `draft`            | tint    | #EFEDEA | #57534E | #78716C |
| `pending_approval` | tint    | #FBEFDC | #92400E | #D97706 |
| `approved`         | outline | surface | #166534 | #16A34A |
| `sent_to_buffer`   | tint    | #E8EEF9 | #1E40AF | #2563EB |
| `published`        | tint    | #DFF0E4 | #14532D | #16A34A |
| `failed`           | tint    | #FAE8E8 | #991B1B | #DC2626 |
| `rejected`         | outline | surface | #991B1B | #DC2626 |
| connected          | dot     | —       | #166534 | #16A34A |
| reconnect needed   | dot     | —       | #92400E | #D97706 |
| disconnected       | dot     | —       | #991B1B | #DC2626 |

**Rules:** color is never the only signal — a badge always carries text. The status hues belong to status exclusively: no green success buttons, no red headings, no amber decorations anywhere else. The `danger` button (§6.5) and danger `Alert` reuse the failed/rejected red because they are the same semantic family.

### 6.3 Spacing

Base unit 4px; raw steps 4, 8, 12, 16, 24, 32, 40, 48, 64 — allowed **only inside `components/ui`**. Pages and feature components compose with the semantic rhythm tokens below. This is how the generous whitespace stays consistent instead of eroding PR by PR:

| Token                 | Value                                    | Meaning                          |
| --------------------- | ---------------------------------------- | -------------------------------- |
| `space-page-x`        | 40 (desktop) / 24 (tablet) / 16 (mobile) | Content horizontal padding       |
| `space-page-top`      | 40                                       | Above the page title             |
| `space-after-display` | 24                                       | Page title → first content       |
| `space-section`       | 40                                       | Between page sections            |
| `space-after-title`   | 12                                       | Section/card title → its content |
| `space-card-gap`      | 16                                       | Between cards in a list/grid     |
| `space-field`         | 16                                       | Between form fields              |
| `space-label`         | 6                                        | Label → input                    |
| `space-inline`        | 8                                        | Icon ↔ text, badge ↔ title       |

Containers: sidebar fixed 240px; content max-width 1200px centered; reading and forms 640px; approval queue 720px; tables/grids full content width. Card grids: 24px gutters, 3/2/1 columns at ≥1024 / ≥640 / below.

**PR rule:** a margin or padding not expressible in these tokens is a design change and requires a spec edit — reviewers reject it.

### 6.4 Surfaces & cards

- The page is quiet paper: most content sits directly on `bg`, grouped by whitespace. A card is used only when something must read as _an object_ — a post, a company, an integration — never as general decoration.
- **Card (v2.2):** `surface` + 1px `border` hairline, radius 14, **`shadow-card` at rest** — a 4%-opacity 1px shadow that separates the card from the warm ground without stacking layers. Interactive cards (CompanyCard, MediaCard): hover = `border-strong` + `shadow-sm`.
- **List mode:** rows separated by hairline rules and whitespace, no boxes — the default for settings summaries, Activity, and tables. Max one level of card nesting (Principle 11).
- **Radius scale (v2.2):** 8px controls & badges · 14px cards · 16px modals/panels · full for pills, dots, avatars, channel monograms.
- **Elevation (v2.2):** `shadow-card` (card at rest) · `shadow-sm` (interactive hover) · `shadow-md` (dropdown/popover) · `shadow-lg` (modal/side panel). The v2.0 rule was "static content never casts a shadow"; cards now do, at one low-contrast level. Everything else is unchanged, and nesting is still capped at one level (Principle 11) — elevation separates a card from the page, it never builds a stack.
- Dark mode is out of scope for v1; the semantic token names above are theme-ready so one can be added later without touching components.

### 6.5 Controls

- **Buttons** — label 14/20 weight 600, radius 4, heights 36 (default) / 32 (compact) / 40 (auth):
  - `primary` — ink (`fg` background, `bg` text) for in-page actions. **The page-level primary action uses `accent` (v2.2)** — one accent-filled button per screen, in the header action slot only. The v2.0 rule reserved accent for links and focus rings so status colours kept the chroma spotlight; that still holds everywhere else, and one button per page does not contend with a StatusBadge for meaning. Exactly one per screen either way (Principle 2).
  - `secondary` — `surface` + hairline border, `fg` text; hover `surface-subtle`.
  - `ghost` — transparent, `fg-muted` text; hover `surface-subtle`.
  - `danger` — #B91C1C solid, white text — only inside `ConfirmDialog` and the danger zone.
  - Loading: spinner replaces label, width locked. Disabled: 45% opacity.
- **Inputs / selects / textarea:** 36px, `surface`, hairline border, radius 4, `body` text; focus = 2px `accent` ring, 2px offset; error = danger border + 13px danger message linked via `aria-describedby`. Label above in `small` 600; help text in `small` `fg-muted`. Native `<select>` styled — no custom dropdown in v1. **Post-content textareas render in `reading` (17/28)** — while editing, the text stays the visual center.
- **Toggles:** 36×20 switch; on = `fg` ink, off = `border-strong`; always with a visible label.
- **Tag input** (forbidden words, competitors): full-radius chips (`surface-subtle`, `small` text, × to remove) inside an input-styled container; Enter/comma commits.
- **Form layout:** groups are separated by whitespace and `micro` overline labels — no fieldset boxes. Max ~7 visible fields per group (Principle 6); forms max-width 640px; dirty state → `SaveBar`.

### 6.6 Data display

- **Tables** (comfortable default): header `micro` uppercase `fg-muted` above a hairline; rows 48px, horizontal hairlines only; hover `surface-subtle`; numerics and timestamps in `data`, right-aligned; sticky header on scroll. Dense surfaces use compact mode (§6.10).
- **Badges (`StatusBadge`):** 22px pill, `micro` text, resolved from the §6.2 status table. Variants: `tint` (default), `outline` (approved, rejected), `dot` (dot + `small` text — connection states and inline mentions). Never color alone.
- **Alerts:** radius 6, status tint background + hairline border in the dot color, icon + `body-strong` title + optional `body` + optional action. Variants map to the §6.2 families.
- **Empty states:** centered — 20px muted icon, one `title` line, one `body` line, one button. Never more (Principle 8).
- **Loading:** skeletons mirror the final layout (shimmer; `prefers-reduced-motion` → static); inline spinners 16px. Full-page spinners banned (Principle 13).

### 6.7 Navigation components

- **Sidebar item:** 32px row, radius 4, `small` `fg-muted`; active = `surface-subtle` bg + `fg` text + 2px `accent` left indicator; hover = `fg` text.
- **TabBar:** text tabs in `body` `fg-muted`; active = `fg` `body-strong` + 2px `accent` underline; count inline in `data` ("Approvals · 4"); horizontal scroll with fade hint on overflow.
- **Breadcrumb:** `small` `fg-muted`, "/" separators, current page `fg`, no link on current.

### 6.8 Icons

Lucide (outline, 1.5px stroke), 16px inline / 20px navigation and empty states. Replaces current emoji icons (🖼️ ✅ 📋) everywhere — emojis read as unfinished. Icons are decorative by default (`aria-hidden`) since text always accompanies them (Principle 12). Icon use stays sparse: in this identity typography carries meaning, not pictographs.

### 6.9 Motion

Tokens: `motion-fast` 120ms ease-out (hovers, fades) · `motion-panel` 200ms (modal/panel: fade + 4px rise) · `motion-leave` 150ms (queue item collapse on approve/reject). Hard cap 250ms. No decorative animation, no bounces. All motion behind `prefers-reduced-motion` (reduce to opacity-only or none).

### 6.10 Density: compact mode

Dense operational screens exist — as **quiet secondary readouts**, not as a different design. One switch, `data-density="compact"` on a region, remaps tokens; components never restyle themselves individually.

| Property                | Comfortable (default) | Compact |
| ----------------------- | --------------------- | ------- |
| Table row height        | 48px                  | 36px    |
| Table cell text         | `body`                | `small` |
| Cell horizontal padding | 16px                  | 12px    |
| `space-section`         | 40px                  | 24px    |
| `space-card-gap`        | 16px                  | 12px    |
| Default button height   | 36px                  | 32px    |

**Never changes in compact mode:** type roles and faces, status colors and badge size (status stays loudest at any density), focus rings, minimum 32px keyboard/touch targets.

**Applies to:** Admin users/companies tables, Activity (full timeline), cron run history, Team table, Buffer profile list.
**Never applies to:** Dashboard, Approvals, Posts cards, Overview, or any form.

### 6.11 Artifact mode: channel-faithful post preview

Direction D's truth, absorbed as a component _mode_ (surfaced by `PostCard`, `ApprovalCard`, and `EditPostModal` — §7):

- **Two registers, never mixed.** The artifact is the only rich object on screen; the chrome around it uses ghost buttons, `data` metadata, and hairlines.
- **Artifact frame:** `surface`, hairline border, radius 6; header row = `ChannelChip` + profile name + scheduled time in `data`.
- **Preview register type:** inside the frame, post text renders in a native sans stack (`-apple-system, "Segoe UI", Roboto, Arial, sans-serif`) at 15/21 — deliberately **not** Literata. `reading` is our voice; the preview register approximates the network's. The visible switch between registers is itself the message: _this is how it will look out there._
- **Fold marker:** a hairline + `micro` label ("Folds here on LinkedIn") at the channel's visible-truncation threshold; character counter in `data` ("212 / 3,000"), turning danger past the limit.
- **Image** cropped to the channel's primary aspect; hashtags placed per the channel config (inline vs. trailing block).
- Channel constants (character limit, fold threshold, aspect) are **facts about external networks, not design tokens** — they live in one maintained constants module and are expected to change:

| Channel   | Char limit | Fold (approx.) | Primary aspect          |
| --------- | ---------- | -------------- | ----------------------- |
| Facebook  | 63,206     | ~477           | 1.91:1 link / 4:5 photo |
| LinkedIn  | 3,000      | ~210           | 1.91:1                  |
| Instagram | 2,200      | ~125           | 4:5                     |
| TikTok    | 2,200      | verify         | 9:16                    |

_(values as of 2026-07 — verify against each network at implementation time)_

- **Defaults:** Approvals shows `reading` mode with a "Preview as {channel}" toggle per card; `EditPostModal` shows a live preview pane at ≥1024px.

---

## 7. Component Library

Format: **Purpose · Props · Variants · States · Used in**. All in `components/ui/` unless noted; existing primitives (Card, Button, Modal, Alert, Badge, Input, PageHeader, EmptyState, Section) are restyled to §6 and extended as below.

1. **AppShell** — global layout: sidebar + content region. Props: `user`, `children`. States: sidebar collapsed (mobile drawer). Used: every authenticated page.
2. **SidebarNav** — global nav list + admin section + user footer. Props: `isGlobalAdmin`, `activeHref`, `attentionCount?`. States: item active/hover/focus. Used: AppShell.
3. **PageHeader** — title + optional description + actions slot. Props: `title`, `description?`, `actions?`, `breadcrumb?`. Used: every page.
4. **TabBar** — workspace/admin tabs. Props: `tabs: {label, href, count?}[]`, `active`. Variants: line (default). States: active, hover, overflow-scroll. Used: company workspace, Admin.
5. **CompanyHeader** — workspace identity strip. Props: `name`, `automationMode`, `bufferStatus`. Used: all workspace tabs.
6. **StatsCard** — count + label, links to filtered view. Props: `value`, `label`, `href?`, `tone?` (default/warning/danger). States: zero (muted), loading skeleton. Used: Overview, Dashboard.
7. **StatusBadge** — canonical post/run status pill. Props: `status` (enum-driven; maps to §6.2 table internally — callers never pass colors). Used: PostCard, ApprovalCard, tables, Dashboard.
8. **ChannelChip** — channel identifier. Props: `channel`, `size?`. Used: post cards, filters, generate panel, channel settings.
9. **RoleBadge** — owner/editor/admin. Props: `role`. Used: Companies grid, Team, Admin users.
10. **ConnectionDot** — status dot + text. Props: `state: connected|disconnected|reconnect`. Used: Buffer card, CompanyHeader, CompanyCard.
11. **FilterBar** — horizontal filter controls + active-filter chips + clear. Props: `filters` (selects/pills config), `value`, `onChange`. States: filters active (chips shown). Used: Posts, Approvals, Sources, Activity, Media (pills).
12. **SearchInput** — debounced search with icon + clear. Props: `value`, `onChange`, `placeholder`. Used: Admin tables.
13. **DataTable** — styled table with sticky header, empty & skeleton states, pagination. Props: `columns`, `rows`, `page`, `onPage`, `emptyState`. Used: Admin users/companies, Team.
14. **PostCard** — lifecycle row for Posts tab. Props: `post`, `capabilities` (canEdit/publish/delete…), callbacks. Variants: default, failed (error line + Retry), flagged (amber note). States: hover, action-loading, highlight (just created). Used: Posts, Dashboard upcoming (compact variant).
15. **ApprovalCard** — full-text review card. Props: `post`, `onApprove/onReject/onEdit`. States: focused (keyboard ring), removing (collapse animation), error-resolved. Used: Approvals.
16. **GeneratePanel** — side panel with generation form + inline preview. Props: `slug`, `channels` (enabled only), `onCreated`. States: idle, previewing, creating, error. Used: Posts; entry from Overview CTA.
17. **EditPostModal** — content/hashtags editor + char counter + image picker trigger. Props: `post`, `channelLimit`, `onSaved`. Used: Posts, Approvals.
18. **ImagePickerModal** — two-tab picker (Gallery / Generate). Props: `slug`, `onSelect`. States: loading grid, generating, error. Used: EditPostModal, GeneratePanel.
19. **MediaCard** — grid tile + detail modal trigger. Props: `asset`, `onDelete`. Variants: upload, ai (badge). Used: Media, ImagePickerModal.
20. **SourceCard** — content source row. Props: `source`, `canManage`, callbacks. Variants: rss/prompt/product/calendar (type badge). States: fetching, fetch-error, disabled. Used: Sources.
21. **SourceFormModal** — add/edit source with type-specific fields. Props: `source?`, `onSaved`. Used: Sources.
22. **ChannelSettingsCard** — collapsible per-channel config (summary ↔ form). Props: `channel`, `config`, `bufferConnected`, `profiles`. States: collapsed, expanded, dirty, saving, buffer-missing (profile select disabled + hint). Used: Settings → Channels.
23. **IntegrationCard** — Buffer connection lifecycle card. Props: `connection`, `canManage`. Variants: not-connected / connected / reconnect. Used: Settings → Buffer.
24. **SetupChecklist** — onboarding progress card. Props: `steps: {label, done, href}[]`. States: in-progress, complete (auto-hides). Used: Overview.
25. **AttentionCard** — dashboard urgent-item row. Props: `severity`, `message`, `action {label, href}`. Used: Dashboard.
26. **ActivityTimeline** — day-grouped audit feed. Props: `entries`, `onLoadMore`, `filter?`. Variants: full (Activity tab), compact (Overview, last 5). Used: Activity, Overview, PostActivityModal.
27. **VersionHistoryModal** — versions list + restore. Props: `postId`, `canRestore`. Used: Posts, Approvals (via overflow).
28. **ConfirmDialog** — standard destructive confirm. Props: `title`, `body`, `confirmLabel`, `tone: danger|default`, `requireText?` (typed-name confirmation), `notesField?` (reject notes). Used: delete post/media/source/company, disconnect Buffer, remove member, reject.
29. **Toast** (+ provider) — transient feedback. Props: `message`, `tone`, `action?` (Undo). Auto-dismiss 5s, hover pauses, `aria-live=polite`. Used: all mutations.
30. **SaveBar** — sticky dirty-form footer (Discard / Save). Props: `dirty`, `saving`, `onSave`, `onDiscard`. Used: all Settings forms.
31. **Skeleton** — shape primitives (line, card, tile, row). Props: `variant`, `count`. Used: every loading state.
32. **EmptyState** — icon + line + one action (per §6.6). Props: `icon`, `title`, `body?`, `action?`. Used: every list/queue.
33. **KeyboardHelpSheet** — "?"-triggered shortcut overlay. Used: Approvals, Posts.
34. **LanguageSwitcher** — EN/BG (existing, moves into sidebar user footer + auth pages).
35. **CompanyCard** — workspace switch card. Props: `company` (name, role, automationMode, pendingCount, bufferStatus, memberCount). States: hover (interactive-card lift, §6.4). Used: Companies grid, Dashboard companies strip.

#### Added in v2.0

36. **PostMetricsStrip** — inline engagement figures on a published post. Props: `metrics` (nullable per field), `syncStatus`, `channel`. Variants: by network (FB/IG field sets). States: synced, pending, not-found, unauthorized, failed (§3.9a table). Renders only non-null metrics; labels engagement rate with its denominator; never averages across channels. Used: PostCard.
37. **AnalyticsKeyCard** — Buffer Personal API Key lifecycle. Props: `status` (`configured`, `last4`, `addedAt`, `lastValidAt`), `canManage`. Variants: not-configured / configured / invalid / read-only-editor. Used: Settings → Buffer.
38. **ContentMixSection** — per-source weekly quota editor + company-mission row + running total against cadence. Props: `mix`, `sources`, `canManage`. States: unset (`NULL`) vs zero must be distinguishable; over-allocation warns without blocking. Used: Settings → Channels.
39. **FeedItemList** — expandable per-source article list with enable/disable toggles. Props: `sourceId`, `items`, `canManage`. States: empty ("nothing new"), all-disabled, loading. Used: SourceCard.
40. **LlmPreferenceControl** — personal preferred-model select. Props: `llms`, `preferredLlmConfigId`. Hidden entirely when no LLM configs are active. Used: sidebar user menu (§2.7).
41. **VerifyEmailCard** — four-state confirmation card (§4.12). Props: `state`, `onResend`. Used: `/verify-email`.

**Status.** Shipped in `components/ui/`: Alert, Badge, Button, Card, ChannelChip, ColorField, ConfirmDialog, ConnectionDot, Container, DataTable, EmptyState, FilterBar, Input, LanguageSwitcher, LinkifiedText, Modal, PageHeader, RoleBadge, SaveBar, Section, SectionHeader, Select, Skeleton, StatusBadge, TabBar, Textarea, Toast. Components 36–41 exist as feature components under `components/company/` and are promoted to the library here so their states are specified rather than improvised. **Not yet built:** SearchInput (12), AttentionCard (25), KeyboardHelpSheet (33), GeneratePanel (16) as a side panel, ApprovalCard (15) as distinct from PostCard.

---

## 8. Dashboard Specification

The Dashboard answers exactly one question: **"What needs my attention today?"** It is an operational triage surface, not an analytics page — no charts, no vanity metrics, no follower counts. Structural facts (layout, states, responsive) are in §4.1 and §5.1; this section defines the content rules.

### 8.1 Section order and content rules

**1. Needs attention** (top; omitted entirely when empty — absence is the reward)

A vertical stack of `AttentionCard`s, hard-capped at 6 rows (overflow: "+ n more" linking to the relevant company). Sourced, in severity order:

| Severity | Trigger                                                                | Message pattern                                 | Action                                        |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| danger   | Post `failed` (any retry count)                                        | "Publish failed — {channel} post for {company}" | **Retry** → post; 3/3 retries → **Open post** |
| danger   | Last cron run `failed`                                                 | "Automation run failed {time}"                  | **View activity**                             |
| warning  | Buffer disconnected / token expired, any company with enabled channels | "Buffer needs reconnecting — {company}"         | **Reconnect** → Settings → Buffer             |
| warning  | Posts `pending_approval`                                               | "{n} posts awaiting approval — {company}"       | **Review** → Posts ?status=pending_approval   |

One row per company per trigger type (aggregate counts, never one row per post).

**2. Upcoming (next 48h)** — up to 8 compact rows across companies: relative time ("in 3h", "Tue 9:00"), `ChannelChip`, company name (only when user has >1 company), first line of content, `StatusBadge` (`approved` or `sent_to_buffer`). Row links to the post. Mirrors the cron's own 48h publish window so the user sees exactly what automation will touch next.

**3. Automation activity** — last 5 outcomes rendered as plain-language sentences from `cron_runs.actions_taken` (never raw JSON): "Weekly schedule generated for Acme — 12 posts", "3 posts sent to Buffer — Beta", "Nothing to do (checked 06:00)". Failed runs appear here _and_ in Needs attention. Links to company Activity tab.

**4. Your companies** — `CompanyCard` strip (per §4.2 card content) + **New company** as the section action. For a single-company user this section stays last: the workspace switcher is a lower-frequency need than the queues above.

### 8.2 Quick actions

No floating action button, no global "quick create". The Dashboard's actions are the contextual buttons inside attention rows plus **New company**. Rationale: every real action (generate, approve, upload) is company-scoped; a global quick-action would just prepend a company picker — an extra step disguised as a shortcut.

### 8.3 Personalization & degradation

- Greeting line uses first name and time of day; date in user locale (EN/BG).
- Editors see the same layout scoped to their memberships; attention rows they cannot act on (e.g. Buffer reconnect for owner-only) render with the message but action replaced by "Ask an owner" hint — visibility without dead buttons.
- Zero companies → first-run state (§3.1). Companies but all-clear → "✓ All clear — nothing needs your attention" hero line; Upcoming + Activity + Companies still render.

---

## 9. Company Workspace

The workspace is the product's center of gravity. Design intent: **a user's weekly session is Overview → Posts (Pending approval) → done.** Everything else supports that loop.

### 9.1 Tab set and rationale

| Tab                  | Frequency        | Role              | Why it earns a tab                                                                                            |
| -------------------- | ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Overview _(default)_ | every visit      | status + router   | Lands daily users on state, not forms (§2.3)                                                                  |
| Posts                | weekly, hottest  | manage lifecycle  | The full record; generation entry point; **holds the approval queue as a filter and carries its count badge** |
| Media                | occasional       | asset library     | Parallel workflow (upload/AI) independent of posts                                                            |
| Sources              | rare after setup | generation inputs | Operationally "daily-work-adjacent": Fetch now, error states — not pure config, so not buried in Settings     |
| Activity             | on demand        | audit trail       | Read-only oversight; separated so queues stay action-only                                                     |
| Settings             | setup + rare     | all configuration | The entire "setup" half of Principle 3                                                                        |

Tab order = frequency order, Settings deliberately last and visually terminal. **Badge logic:** exactly one tab carries a count badge — **Posts**, showing the live `pending_approval` count. More badges = no badges; one badge is a signal, five are wallpaper. Zero is never rendered: a badge reading "0" is a pull signal for nothing.

**Six tabs, not eight.** The v2.0 bar had eight. Team was never a peer of Posts and Media — it is rare-touch configuration, edited at onboarding and then nearly never — and returned to Settings → Team in Phase 4b. Approvals left in Phase 4c, folding into a Posts filter (§2.3); its badge moved to Posts rather than being lost, because the pull signal was the tab's genuine contribution and Principle 4 still requires one. The tab set is closed — a new tab requires a frequency argument, not just a new feature. This is the rule that keeps content mix and analytics from each claiming one.

### 9.2 Setup vs daily work — the split, made concrete

Everything on today's single company page is redistributed; nothing is dropped:

This table is the working map for Phase 4b. Left column = where the component lives in `app/(dashboard)/companies/[slug]/page.tsx` today; right column = its destination route.

| Today                                         | Redesign home                                  | Move type                     |
| --------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| `CompanyOverview` stats + metadata `dl`       | Overview stat row (§9.3) — metadata dropped    | rebuild                       |
| `BrandGuidelinesForm` (`?tab=settings`)       | `/settings/brand`                              | relocate                      |
| `CompanyMembers` (`?tab=team`)                | `/settings/team`                               | relocate                      |
| `BufferConnectionCard` (`?tab=settings`)      | `/settings/buffer` (status dot also in header) | relocate                      |
| `AnalyticsKeyCard` (`?tab=settings`) _(v2.0)_ | `/settings/buffer` — second card               | relocate                      |
| `ChannelConfigSection` (`?tab=settings`)      | `/settings/channels`                           | relocate                      |
| `ContentMixSection` (`?tab=sources`) _(v2.0)_ | `/settings/channels` — below channel cards     | **relocate across tabs**      |
| `ContentSourcesSection` (`?tab=sources`)      | `/sources`                                     | relocate                      |
| `GeneratedPostsSection` (`?tab=posts`)        | `/posts` — including the pending queue         | relocate                      |
| `PostStatusFilterBar` _(v2.0)_                | `/posts` — restyled to `FilterBar`             | restyle                       |
| `ApprovalQueueSection` (`/approval`)          | Deleted in Phase 4c — the queue is a filter    | ✅ **deleted**                |
| Overview module-card grid                     | Removed — the tab bar is the navigation        | **delete**                    |
| `company-section-card.tsx`                    | Removed — already dead code, imported nowhere  | **delete**                    |
| `LlmPreferenceCard` (Dashboard) _(v2.0)_      | Sidebar user menu (§2.7)                       | **relocate out of workspace** |

Nothing is dropped except the Overview metadata list (slug and creation date are not decisions anyone makes) and the two deletions marked above, both of which are duplicate navigation.

### 9.3 Overview composition rules

- **SetupChecklist** renders only while `<5/5`; completion is computed (brand row exists & touched, Buffer connected, ≥1 channel enabled, ≥1 source, ≥1 post) — once all true it disappears forever (no "dismiss" needed, no setting stored).
- **Stat row (v2.2 — five cards).** Posts this month · Pending approval · Published · Connected channels · RSS sources. Each is a link into the work it counts, each carries a tinted icon tile identifying the metric, and the two month-over-month cards carry a delta chip. The v2.0 four-card row is superseded; its remaining targets are listed below.
- _Superseded v2.0 stat row_ (4 `StatsCard`s): Pending approvals → Posts filtered `pending_approval`; Scheduled this week → Posts filtered `approved+sent`; Published this week → Posts filtered `published`; Failed → Posts filtered `failed` (`tone=danger` when >0, hidden when 0 _and_ no failure in 7 days).
- **Two-column dashboard (v2.2).** Below the stat row, four panels in a 2×2 grid sharing one `OverviewPanel` shell (identical header, padding and footer link, so the eye can rely on the same furniture in every quadrant):
  - **Upcoming posts** — pending-approval and approved posts ordered by `scheduled_for` (unscheduled last), max 5, each row: channel monogram, thumbnail, first line, date, StatusBadge. Replaces v2.0's "This week".
  - **Performance** — one channel at a time, never blended (§2.6). No trend chart: metrics are per-post and no company-wide daily series exists to plot, so a chart would have to invent its history.
  - **RSS sources** — max 4, each row: name, host, new-article indicator, last fetched.
  - **Recent activity** — last 5 audit entries, icon + action + actor + relative time, with an exact `<time datetime>` retained for precision.
- Channel markers in dense rows are **monograms, not brand icons**: Lucide ships marks for Facebook, Instagram and LinkedIn but none for TikTok, so an icon set would render three channels one way and the fourth another inside a single list.
- The contextual primary action (§4.4) is rendered in the `PageHeader` actions slot — never floating.

### 9.4 Approval workflow inside the workspace

Covered in §3.8/§4.6; workspace-level glue: the **Posts tab badge**, the Pending-approval filter chip, the Overview stat card, and the Dashboard attention row all derive from the same count and must agree. Since v2.1 two of those sit on one screen, so "must agree" is now enforced rather than assumed — the badge and the chip read one predicate, and a card action refreshes the server-rendered badge instead of letting local state and server state diverge (§4.5). After the final approval, the empty state links _forward_ ("View scheduled posts") — the loop always exits somewhere useful, never at a dead end.

### 9.5 Media workflow inside the workspace

Two entry directions, one library: (a) library-first — Media tab, upload/generate, assets wait; (b) post-first — EditPostModal/GeneratePanel → ImagePickerModal → select or generate, asset lands in the same `media_assets` pool. Deleting from Media warns when the asset is attached to posts (`ConfirmDialog` body lists count). The 50-asset cap surfaces as "37/50" in the Media page actions row _before_ users hit it.

### 9.6 Roles inside the workspace

| Capability                                                 | Owner / global admin | Editor                                             |
| ---------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| Tabs visible                                               | all                  | all                                                |
| Approve / reject / edit / generate / media / fetch sources | ✓                    | ✓                                                  |
| Settings forms                                             | editable             | read-only + "Only owners can change settings" note |
| Delete company, disconnect Buffer, manage team             | ✓                    | hidden (not disabled)                              |

Rule: capabilities the user _can never have_ are **hidden**; capabilities _temporarily unavailable_ (Buffer not connected, cap reached) are **disabled with an inline reason**.

### 9.7 Layouts

Overview: §5.2 · Posts: §5.3 · Approvals: §5.4 · Media: §5.5 · Sources: §5.6 · Settings: §5.7. One addition — Activity:

```
│ Overview | Posts (4) | Media | Sources | Activity | Settings             │
│──────────────────────────────────────────────────────────────────────────│
│ [Action type ▾]                                                          │
│  TODAY                                                                   │
│  ├ ✓ 10:12  Maria approved a LinkedIn post              → post           │
│  ├ ✎ 09:41  Ivan edited a Facebook post (v3)            → post           │
│  YESTERDAY                                                               │
│  ├ ⚙ 06:00  Weekly schedule generated — 12 posts                         │
│  ├ ↗ 06:00  3 posts sent to Buffer                                       │
│                        [Load more]                                       │
```

---

## 10. Responsive Strategy

Breakpoints (Tailwind defaults): **desktop ≥1024** · **tablet 640–1023** · **mobile <640**. The strategy is _reflow, never remove_: every capability reachable at every size; what changes is density and chrome.

### 10.1 Desktop (≥1024)

Reference layout: fixed 240px sidebar, content max-width 1200px, two-column regions where specified (Overview), full `FilterBar`, side panels 420px overlaying from the right, hover states + keyboard shortcuts active.

### 10.2 Tablet (640–1023)

- **Sidebar → icon rail (64px)** with tooltips on hover/focus; user footer collapses to avatar menu. Content keeps 24px padding.
- Two-column regions stack (Overview: This week above Recent activity). Card grids drop to 2 columns; media grid 3–4.
- Settings keeps left sub-nav until 768px, then switches to the mobile select pattern.
- Tables (Admin, Team) scroll horizontally inside the card with a right-edge fade cue; sticky first column for identity.
- GeneratePanel remains a right overlay at ~60% width.

### 10.3 Mobile (<640)

- **Sidebar → hidden; top app bar** (44px): hamburger (opens full-height drawer with the same nav), page title, contextual action. Drawer traps focus, closes on route change.
- **Workspace TabBar → horizontally scrollable** pill row under the company header, active tab auto-scrolled into view; count badge preserved.
- Cards go full-bleed-minus-16px; `PostCard` metadata wraps to a second line; row actions collapse to overflow ⋯ (§4.5).
- `ApprovalCard` buttons become a full-width 3-button row pinned at card bottom; Approve rightmost (thumb zone).
- Modals <640px render as **bottom sheets** (full-width, 12px top radius, drag-to-dismiss + explicit ×); `GeneratePanel` and `EditPostModal` become full-screen sheets with sticky header (title + close) and sticky footer (actions).
- `FilterBar` collapses to a single **Filters** button opening a sheet; active filter count on the button ("Filters · 2").
- `SaveBar` sticks above the keyboard-safe area; dashboard sections stack single-column; stat row becomes a 2×2 grid.
- Touch targets ≥44×44 (§11); hover-only affordances get always-visible equivalents (overflow ⋯ always rendered on touch).

---

## 11. Accessibility

Target: **WCAG 2.2 AA**. These are acceptance criteria, not aspirations — PRs failing them don't merge.

- **Keyboard:** every action reachable by Tab in visual order; no positive `tabindex`. Skip-link ("Skip to content") first focusable in the shell. Approvals/Posts support j/k (next/prev), a/r/e (approve/reject/edit), ? (shortcut sheet) — all optional accelerators, never the only path. Esc closes topmost layer only.
- **Focus:** visible 2px accent ring (`:focus-visible`) on light and dark surfaces; modals/sheets/drawers trap focus and restore it to the trigger on close; after a queue card is removed, focus moves to the next card (or the empty state heading).
- **Contrast:** text ≥4.5:1, large text and UI borders/icons ≥3:1. Token pairs in §6.2 are pre-validated; tinted badge backgrounds must keep their solid-color text ≥4.5:1. Status never conveyed by color alone (badge text, dot + label).
- **Touch targets:** ≥44×44px on touch devices (24px visual icons get padding); ≥24×24 with spacing exceptions per WCAG 2.2 §2.5.8 on desktop-density tables.
- **ARIA & semantics:** native elements first (`button`, `a`, `select`, `table`); landmarks: `nav` (sidebar, labeled), `main`, `header`. TabBar = `tablist` pattern when panels swap in place, plain links when tabs are routes (workspace tabs are routes → links with `aria-current="page"`). Counts in accessible names ("Approvals, 4 pending"). Toasts `aria-live="polite"`; attention/error alerts `role="alert"`. Icons `aria-hidden` (text carries meaning, §6.8).
- **Screen readers:** every page has a unique `h1` (PageHeader title); heading levels never skip; tables use `th scope`; timeline times use `<time datetime>`; form errors referenced by `aria-describedby` and announced on submit by moving focus to the first error or the form-level alert. Language switch updates `<html lang>` (en/bg) so pronunciation follows.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables shimmer, collapse, and slide animations — replaced by instant state change or opacity fade ≤80ms (§6.9).
- **Forms:** visible labels always (no placeholder-as-label); `autocomplete` on auth/profile fields; `ConfirmDialog` typed-name confirmation is case-insensitive and paste-allowed (a11y over ceremony).

---

## 12. Implementation Roadmap

**This is a resumption plan, not a greenfield one.** Phases are sequential and shippable; each leaves the app fully functional. "Complexity" = engineering effort; "Risk" = chance of regressions/UX misses; "Impact" = user-visible value.

### 12.0 Status at 2026-07-20

| Phase                       | Status                        | Evidence / what remains                                                                                                                                                                                                   |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Design system           | ✅ **Complete**               | 52 tokens in `@theme`; Literata + Source Sans 3; all 11 new primitives built; zero emoji icons remain                                                                                                                     |
| 2 — Global shell            | ✅ **Substantially complete** | Sidebar = Dashboard/Companies/Admin(gated); mobile drawer; breadcrumbs plumbed; `aria-current` set. **Missing:** skip-link (§11)                                                                                          |
| 3 — Dashboard               | ⚠️ **Partial**                | Has: stat row, setup-needed, pending work, recent activity. **Missing:** Upcoming (48h), Automation activity, companies strip, AttentionCard severity model. **Wrong home:** LlmPreferenceCard (§2.7)                     |
| 4a — Route conversion       | ✅ **Complete** (2026-07-20)  | All tabs are real routes; `/approvals` and `/activity` renamed with 308s; legacy `?tab=` links translated; monolith split into five pages. Verified by before/after markup diff — all 8 pages identical                   |
| 4c — Approval consolidation | ✅ **Complete** (2026-07-20)  | Approvals tab removed; queue is now `?status=pending_approval` on Posts; `ApprovalQueueSection` deleted; both old URLs 308 in one hop; badge moved to Posts from a single `countPendingApprovals` source. 785 tests green |
| 4b–4d — Workspace           | ⚠️ **Remaining**              | Settings not split into sub-pages; Team still in the tab bar; Overview module grid still present; two setup-status implementations                                                                                        |
| 5 — Daily-work surfaces     | ⬜ Not started                | Two approval implementations exist; PostCard is a 627-line flat action bar                                                                                                                                                |
| 6 — Settings & admin        | ⬜ Not started                | —                                                                                                                                                                                                                         |
| 7 — Polish                  | ⬜ Not started                | —                                                                                                                                                                                                                         |

**Phase 4 is now the entire critical path.** It is subdivided below because it is too large to land safely as one change, and because part of it is corrective rather than additive.

### Phase 4a — Route conversion (no visual change) — ✅ shipped 2026-07-20

Converted `?tab=` into real route segments (`/posts`, `/sources`, `/settings`, `/settings/team`), renamed `/approval`→`/approvals` and `/audit-log`→`/activity` behind 308s, and split the 501-line monolith into five pages — each doing its own auth, `getCompany`, and data loading, matching the pattern the already-routed pages used. The seven nullable bindings and four `if (activeTab === …)` blocks are gone.

Legacy `?tab=` links are translated by `lib/companies/legacy-tab-redirect.ts` rather than being allowed to fall through to the overview. It carries the rest of the query string across the hop, which is what keeps `?tab=settings&buffer=connected` intact, and returns "no redirect" for an unrecognized tab so a stale link still renders the overview instead of 404ing.

**Verified:** all 8 pages render byte-identical markup before and after (captured, stashed to HEAD, re-captured, diffed — only `href` values and four `<title>` tags differ). Every legacy URL exercised against the running app. 780 tests, typecheck, lint, build all clean.

**Decisions taken (approved 2026-07-20):**

- **Per-route page titles kept.** Posts/Sources/Settings/Team gained `Posts – {slug} – …` style titles, matching the convention `/approvals`, `/media`, and `/activity` already followed. The only user-visible delta in the phase.
- **Team keeps its tab** in the bar, pointing at `/settings/team`. Only the route moved; the tab leaves in 4b when the Settings sub-nav exists to hold it. Moving the route and moving the tab are separate changes, and only the first is architectural.
- **The Buffer OAuth alert bug was left in place** — see 4b.

**Complexity:** High · **Risk:** Medium–High · **Impact:** Very High · **Depends on:** —

### Phase 4b — Settings split & relocations

Create the five sub-pages of §2.4 with left sub-nav (desktop) / select (mobile). Relocate per the §9.2 table: content mix from Sources → `/settings/channels`; analytics key into `/settings/buffer` as its own card. Team's route already moved in 4a; here it leaves the tab bar, which drops to seven entries.

**Two known bugs are fixed in this phase, not before it:**

1. **The Buffer OAuth result has never been shown to the user.** `app/api/v1/buffer/callback/route.ts` redirects to `/companies/{slug}?buffer=connected` (and `?buffer=error`), but `BufferConnectionCard` — the only component that reads `buffer` and renders the success/error `Alert` — lives under Settings, so the parameter has always landed on a page that ignores it. `/dashboard?buffer=error` is dropped the same way; the dashboard reads no search params. Point the callback at `/settings/buffer`, and give the dashboard an error path for the no-session case. Deliberately preserved through 4a, which was architecture-only.
2. **An editor's `FORBIDDEN` on the analytics key renders as "not configured"** — a permission state misreported as a setup state (§2.4). It must read as "only owners can manage this key".

**Verify:** editors see read-only settings; **and drive a real OAuth round-trip** — connect, reconnect, disconnect, success, cancel, error. Note this cannot be exercised against `localhost` while `BUFFER_REDIRECT_URI` points at the deployed app; either register a local redirect URI with Buffer or verify on a preview deployment.
**Complexity:** Medium–High · **Risk:** Medium · **Impact:** High · **Depends on:** 4a

### Phase 4c — Approval consolidation — ✅ shipped 2026-07-20

**Re-scoped.** As written, 4c was "Overview rebuild & duplicate-nav removal". The Overview rebuild moved to **4c-ii** below; what shipped under 4c is the approval consolidation, which resolves §2.1 row 5 (the queue implemented twice) and is a precondition for Phase 5's card merge — there is now one card to rebuild instead of two to reconcile.

Removed the Approvals tab and folded the queue into Posts as a fifth status filter (§4.5). `ApprovalQueueSection` deleted; `GeneratedPostCard` already carried the whole approval workflow, so no mutation logic moved. `/approval` and `/approvals` both 308 to `/posts?status=pending_approval`, one hop each. The count badge moved to the Posts tab, sourced by a new `countPendingApprovals` service called from `CompanyWorkspaceHeader` itself so every workspace page shows the same number without threading a prop through six pages.

**One bug fixed:** `GeneratedPostsSection` never passed `onStatusChange` to its cards, so approving a post left the parent's list holding a stale status. Cosmetic before; load-bearing once the filter and badge count from that list. Actions now update the list and call `router.refresh()`.

**Not done here:** the channel filter that `ApprovalQueueSection` had was dropped rather than ported — §4.5 specifies channel as a `FilterBar` facet for the whole Posts page, which is Phase 5's work, and re-adding a pending-only channel filter first would have built something Phase 5 deletes.

**Verified:** 785 tests (5 new), typecheck, lint, build clean.
**Complexity:** Medium · **Risk:** Medium — touches approve/reject/submit · **Impact:** High · **Depends on:** 4a

### Phase 4c-ii — Overview rebuild & duplicate-nav removal

Replace the metadata `dl` with the §9.3 stat row; add the contextual primary action (§4.4). **Delete the module-card grid and `components/company/company-section-card.tsx`** (already dead code). This is the phase that removes the third navigation layer. 4c removed the grid's Approval card only, because that card was a navigation reference to a retired page; the grid itself survives until this phase.
**Complexity:** Medium · **Risk:** Low — mostly deletion · **Impact:** High (largest single clutter reduction) · **Depends on:** 4a

### Phase 4d — Onboarding consolidation

One setup-status service behind both the dashboard and the Overview checklist, replacing today's two implementations (`SetupChecklist` props vs. `getSetupStatuses`). Re-point checklist deep links at the new Settings sub-routes. Apply §9.3's rule: the checklist disappears permanently at 5/5 — no persistent "ready" card.
**Complexity:** Low–Medium · **Risk:** Low · **Impact:** Medium–High (first-run quality) · **Depends on:** 4b

### Phase 5 — Daily-work surfaces

Rebuild Posts, the approval experience under the Pending filter (~~merge the two implementations~~ — done in 4c; what remains is optimistic actions, keyboard shortcuts, no-truncation cards per §4.6), Media (grid, detail modal, cap indicator), Sources (SourceCard, feed-item list, SourceFormModal), Activity (ActivityTimeline, filters).

**Posts scope, itemized.** Phase 4c made Posts the workspace's busiest page — it now holds the full lifecycle _and_ the approval queue — so its rebuild is specified rather than summarized. All five items are one page's worth of work and land together; splitting them would ship a filter bar that reflows into a card layout that changes underneath it.

1. **Status filters** — restyle the shipped five-way control (§4.5) to `FilterBar`. Five groupings preserved, lifecycle order preserved, `?status=` still URL-synced and shareable, counts still from `lib/posts/post-status-filter.ts`. The Pending chip keeps the count that agrees with the Posts tab badge (§9.4). Restyle only: no grouping changes without changing that module and its tests.
2. **Channel filter** — the facet 4c dropped, rebuilt as a **general Posts-page filter available under every status view**, not a pending-only control. Composes with status rather than replacing it (`?channel=` alongside `?status=`), shows only channels the company has posts on, and is a `FilterBar` peer of status — one bar, two facets, not two bars.
3. **Search** — free-text over post content within the loaded list, same instant client-side model as the filters, composing with both facets. `SearchInput` is built in Phase 6 for Admin; whichever phase lands first owns the primitive and the other reuses it.
4. **Compact post cards** — `PostCard` with progressive disclosure: one primary action plus overflow, image controls / versions / metrics behind expansion, one unified error region replacing today's five inline `Alert` slots. Compact is the default density; the Pending filter's no-truncation rule (§4.6) is the documented exception, because a reviewer must read the whole text before approving it.
5. **Responsive filter bar** — the three controls above must survive 375px without becoming a wall. Per §4.5/§10: row actions collapse into overflow <768px, and the bar itself reflows (facets to a sheet or select) rather than horizontally scrolling a nav-like strip.

Plus `GeneratePanel` with the §3.7 two-control-plus-Options form.

**Risk note:** this touches approve/reject/publish. Mutation behavior must be identical before and after — verify by driving the flows, not by typecheck alone. Note also that filtering and search are client-side over the loaded list: they narrow what is loaded, not what exists, and the empty states must keep saying which of the two the user is looking at (§4.5).
**Complexity:** High · **Risk:** Medium · **Impact:** Very High (the 15-min/week loop) · **Depends on:** Phase 4

### Phase 6 — Dashboard completion & admin

Finish §8: Upcoming (48h), Automation activity, companies strip, AttentionCard severity model. Move `LlmPreferenceCard` into the sidebar user menu (§2.7). Admin tabs with `DataTable` + provider rows; build `SearchInput`.
**Complexity:** Medium–High · **Risk:** Low (largely additive) · **Impact:** High · **Depends on:** Phase 4

### Phase 7 — Polish & hardening

Empty/loading/error audit against §4 (every page, all three states), responsive audit at 375/768/1280, accessibility pass against §11 (**add the missing skip-link**, keyboard walk, screen-reader smoke test, contrast check), motion + reduced-motion, i18n audit (all new strings in `en`/`bg` — per project convention Bulgarian must be idiomatic, never literal translation), remove remaining dead components and old page shells.
**Complexity:** Medium · **Risk:** Low · **Impact:** Medium–High · **Depends on:** Phases 5, 6

**Sequencing.** 4a → 4b → 4c/4c-ii → 4d; 4c and 4c-ii are independent of each other and of 4b, and may run in parallel if streams are available. 4c shipped ahead of 4b for this reason. Phase 6 may run in parallel with Phase 5. Every phase must pass `npm run typecheck && npm run lint && npm run build`, plus a manual check of the §3 flows touching the changed surfaces. One logical commit per phase.

---

## Implementation Checklist

Acceptance checklist for the whole redesign. An item is done only when it holds on desktop, tablet, and mobile, in both EN and BG. Checked items were verified against the codebase on 2026-07-20.

### Foundation (Phase 1) — ✅ complete

- [x] Design tokens (§6.1–6.4) defined in `app/globals.css` via Tailwind 4 `@theme`; no ad-hoc hex/px in components
- [x] Existing primitives restyled to spec: Button, Card, Badge, Alert, Input, Modal, EmptyState, PageHeader, Section
- [x] New primitives built: StatusBadge, ChannelChip, ConnectionDot, RoleBadge, Skeleton, Toast, ConfirmDialog, FilterBar, TabBar, SaveBar, DataTable (§7)
- [x] Canonical status→color map (§6.2) used by StatusBadge only — no per-page status styling
- [x] All emoji icons replaced with Lucide (§6.8)

### Shell & navigation (Phase 2) — ✅ substantially complete

- [x] Sidebar contains only Dashboard, Companies, Admin (gated), user footer with LanguageSwitcher; disabled links removed
- [x] Mobile: top app bar + focus-trapped nav drawer; tablet: icon rail (§10)
- [ ] **Skip-link** _(missing)_, landmarks, `aria-current` on active nav (§11) — `aria-current` done
- [x] Auth pages restyled (centered card, §4.12)
- [ ] Personal LLM preference lives in the user footer, not the Dashboard (§2.7)

### Dashboard (Phase 3 / 6) — ⚠️ partial

- [ ] Needs-attention aggregation: approvals, failed posts, Buffer state, failed cron runs — severity-ordered, capped at 6, contextual actions (§8.1) — _pending-approval aggregation done; failed posts, Buffer state, cron runs missing_
- [ ] Upcoming 48h list, automation activity in plain language, companies strip
- [x] First-run state (zero companies) and all-clear state (§8.3)

### Company workspace (Phase 4) — ⚠️ divergent

- [x] Tabs **routed** (not `?tab=`): Overview (default) · Posts · Approvals · Media · Sources · Activity · Settings; old `/approval` and `/audit-log` redirect _(4a)_
- [x] Legacy `?tab=` links still resolve, carrying their remaining query string _(4a)_
- [x] Tab bar is six entries — Team left the bar in 4b, Approvals in 4c (§9.1)
- [x] CompanyHeader with company identity on every tab
- [ ] CompanyHeader carries automation badge + Buffer dot
- [ ] Overview: SetupChecklist (auto-hides at 5/5), stat row, This week, Recent activity, contextual primary action (§9.3) — _checklist done but persists as a "ready" card; stat row absent_
- [ ] Overview module-card grid and `company-section-card.tsx` deleted (§9.2)
- [ ] Settings split into five sub-pages with sub-nav (§2.4)
- [ ] Content mix relocated Sources → Settings → Channels (§2.3)
- [ ] Analytics key card in Settings → Buffer; editor `FORBIDDEN` renders as a permission message, not "not configured" (§2.4)
- [ ] Posts tab badge, Pending filter chip, Overview stat, and Dashboard row all derive from one count and agree (§9.4) — _badge + chip done in 4c; Overview stat row not built_
- [ ] One setup-status source behind both Dashboard and Overview (Phase 4d)
- [ ] Monolith company page removed; every §9.2 mapping row has a new home

### Daily work (Phase 5)

- [ ] Posts: FilterBar, PostCard with status-contextual actions, GeneratePanel with preview→create flow (§4.5, §3.7)
- [ ] PostCard uses progressive disclosure: one primary action + overflow; image controls, versions, and metrics behind expansion; a single error region (§4.5)
- [ ] Status filter restyled to `FilterBar`, five groupings preserved, `?status=` still shareable (§4.5)
- [ ] Channel filter as a general Posts-page facet under every status view, composing with status via `?channel=` (§12 Phase 5)
- [ ] Search over post content, composing with both facets, same client-side model (§12 Phase 5)
- [ ] Compact PostCard default density; Pending filter keeps full text as the documented exception (§4.6)
- [ ] Filter bar reflows at 375px rather than horizontally scrolling (§10)
- [ ] Metrics strip on published posts: null metrics omitted, engagement rate labeled with denominator, never cross-channel averaged (§3.9a)
- [x] The two approval implementations merged into one card component (§9.2) _(4c — `ApprovalQueueSection` deleted)_
- [ ] Generate panel shows channel + source; language, model, and link override behind Options (§3.7)
- [ ] Pending-approval filter: full-text cards, optimistic approve with toast, reject with notes dialog, j/k/a/r/e shortcuts + help sheet (§4.6)
- [ ] Media: grid, filter pills, cap indicator, detail modal, AI generation placeholder tile; ImagePickerModal two-tab flow (§4.7, §3.12)
- [ ] Sources: SourceCard with fetch states, feed-item list with per-item toggles, SourceFormModal with type-specific fields (§4.8, §3.6)
- [ ] Activity: day-grouped timeline, action filter, Load more (§4.9)

### Settings & admin (Phase 6)

- [ ] Settings sub-nav (select on mobile): General (+ danger zone with typed-name delete), Brand (3 groups), Channels (collapsible cards, buffer-missing hints, content mix), Buffer (3-state IntegrationCard + AnalyticsKeyCard, OAuth returns land here), Team (table + inline invite, last-owner guard)
- [ ] Content mix: unset (`NULL`) and zero are distinguishable in the control; hidden until ≥1 source exists (§3.6a)
- [ ] SaveBar on all settings forms; editors get read-only + note, never 403 (§3.3, §9.6)
- [ ] Admin: Users / Companies / LLM providers tabs, DataTable with search + pagination, single-Active provider enforcement UI (§4.11)

### Quality gates (Phase 7 — apply to every page)

- [ ] Empty, loading (skeleton), and error states implemented exactly as specified in §4 — no page ships with a missing state
- [ ] Responsive behavior verified at 375 / 768 / 1280 px per §10; bottom sheets, filter sheet, scrollable tabs on mobile
- [ ] WCAG 2.2 AA pass per §11: keyboard walk of every flow in §3, focus management in modals/queues, contrast check on all token pairs, `aria-live` on queue mutations, reduced-motion honored
- [ ] All new strings present in `i18n/messages/en.json` and `bg.json`; `<html lang>` follows the switcher
- [ ] Dead components removed (CompanySectionCard module grid, old page shells); `npm run typecheck && npm run lint` clean

---

_End of specification. Related documents: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (product/backend plan this UI spec layers onto)._
