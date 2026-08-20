/**
 * The articles the MADLAD trial is actually about.
 *
 * Three short, original texts written for this repo — not copies of anyone's article —
 * each covering one of the subject areas where the prompt-based path has been observed
 * to drift, pad, or answer about the wrong object. They are the shared input for two
 * different jobs, deliberately kept in ONE place so the two cannot diverge:
 *
 *   • the segmentation regression tests, which assert that the structure below
 *     survives a round trip untouched;
 *   • `npm run translate:benchmark`, which sends these same texts to both engines so a
 *     person can read the two Bulgarian renderings side by side.
 *
 * Every fixture is built to be hostile to the split/reassembly in a specific way, and
 * that is the point — the traps are listed on each one. Anything that reads like
 * marketing copy is there because marketing copy is what the feeds carry.
 */

export interface TranslationFixture {
  /** Stable id — also the `--fixture` argument of the benchmark. */
  name: string;
  /** What this text is meant to catch. */
  traps: string;
  title: string;
  content: string;
}

/**
 * Traps: a decimal range in years, a bar/psi measurement, a bulleted checklist whose
 * items are single-newline separated, an abbreviation mid-sentence ("approx."), and a
 * URL that must come back unbroken.
 */
const FIRE_EXTINGUISHER: TranslationFixture = {
  name: "fire-extinguisher",
  traps: "decimals, units, bullets, abbreviation, URL, blank lines",
  title: "How long do fire extinguishers last?",
  content: `A fire extinguisher can last between 5 and 15 years, depending on its type and how it has been stored. The manufacturing date is stamped on the cylinder or printed on the label, and it is the date that matters — not the date of purchase.

Check the pressure gauge once a month. The needle should sit inside the green band, at approx. 12.5 bar for a standard powder unit. A needle in the red on either side means the extinguisher will not discharge properly in an emergency situation.

What to inspect:
- The pressure gauge needle is in the green zone
- The safety pin and tamper seal are intact
- The hose is not cracked, blocked or perished
- There is no rust on the cylinder, base or bracket

Rust can damage the fire extinguisher long before its service life ends. A unit stored on a damp concrete floor will corrode from the base upward, and corrosion under the paint weakens the cylinder wall where the pressure is highest.

Full inspection guidance is published at https://example.com/safety/extinguisher-checklist and should be reviewed once a year.`,
};

/**
 * Traps: a heading line, a spec block whose rows are separated by single newlines, a
 * price with a thousands separator and decimals, mixed metric/imperial units, and a
 * model code that must not be translated or renumbered.
 */
const POWER_TOOLS: TranslationFixture = {
  name: "power-tools",
  traps: "headings, spec rows, price, model code, mixed units, numbered list",
  title: "Brushless cordless drill driver: what changed",
  content: `A brushless motor has no carbon brushes to wear down, so it runs cooler, lasts longer and turns more of the battery's charge into torque. On a cordless drill driver that difference is measurable: the same 5.0 Ah pack drives noticeably more screws per charge than it would through a brushed motor.

Key specifications
Model: DCD-800 P2
Maximum torque: 90 Nm
Chuck: 13 mm keyless
Weight with battery: 1.6 kg
Price: 1,299.00 BGN

Batteries are the part most people get wrong. Three rules:
1. Store packs at roughly half charge if the tool will sit unused for a month
2. Never leave a battery on the charger over winter in an unheated garage
3. Replace a pack that has visibly swollen, whatever its remaining capacity

The batteries should be fully charged before the first use, and a new pack usually reaches its rated capacity only after three or four full cycles.`,
};

/**
 * Traps: short declarative sentences of the kind an NMT model can merge, a colon that
 * is not a sentence end, an initial ("J."), and a single-line paragraph between two
 * multi-line ones.
 */
const SAWHORSE: TranslationFixture = {
  name: "sawhorse",
  traps: "short sentences, colon, initial, single-line paragraph",
  title: "Choosing a sawhorse for the workshop",
  content: `A sawhorse provides support while cutting wood. It holds the workpiece at a comfortable height and keeps the blade clear of the floor. Used in pairs, two of them will carry a full sheet of plywood without flexing.

There are three things to look at: the load rating, the leg spread and the top surface. A rating of 250 kg per horse is enough for framing timber. A wider leg spread is more stable but takes more room in a small workshop.

The design has barely changed since J. Wilson patented the folding version.

A sacrificial top matters more than most buyers expect. A softwood beam bolted across the head lets the saw run a few millimetres past the workpiece without touching steel. Replace it when it is cut through; it costs almost nothing and it protects the horse underneath.`,
};

export const TRANSLATION_FIXTURES: readonly TranslationFixture[] = [
  FIRE_EXTINGUISHER,
  POWER_TOOLS,
  SAWHORSE,
];

/** Looks a fixture up by name. Returns null rather than throwing — callers report better. */
export function findTranslationFixture(name: string): TranslationFixture | null {
  return TRANSLATION_FIXTURES.find((f) => f.name === name) ?? null;
}
