/**
 * EXPERIMENT — not wired into the production pipeline. Evaluation corpus and technical
 * glossary for the MADLAD vs TranslateGemma (native) vs TranslateGemma (+glossary)
 * comparison. Read-only with respect to production code; this file only exports data.
 *
 * Every sample declares its `origin`:
 *   "real-fixture"  — verbatim from lib/ai/translation/translation-fixtures.ts, the
 *                      project's own MADLAD stress fixtures. NOT copied from a live
 *                      article; that file's own header explains they are original
 *                      texts written for this repo, not real RSS content either — but
 *                      they ARE the project's real, existing benchmark fixtures, reused
 *                      here unmodified, as instructed.
 *   "synthetic"     — authored for this experiment, to cover domains the existing
 *                      fixtures do not (plumbing, HVAC, PC hardware, etc). These are
 *                      NOT real articles and must not be reported as such.
 */

import { TRANSLATION_FIXTURES } from "@/lib/ai/translation/translation-fixtures";

export type SampleOrigin = "real-fixture" | "synthetic";

export interface EvalSample {
  id: string;
  domain: string;
  origin: SampleOrigin;
  title: string;
  content: string;
}

const fromRealFixture = (name: string, domain: string): EvalSample => {
  const f = TRANSLATION_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`fixture ${name} not found`);
  return { id: `real:${name}`, domain, origin: "real-fixture", title: f.title, content: f.content };
};

const SYNTHETIC: EvalSample[] = [
  {
    id: "syn:construction-rebar",
    domain: "construction",
    origin: "synthetic",
    title: "Reinforcing a concrete slab",
    content:
      "Rebar increases the tensile strength of a concrete slab, which on its own resists compression well but cracks under tension. A typical residential floor uses 10-12 mm bars spaced 200 mm apart in a grid, tied with wire rather than welded. The concrete mixer should run for at least 3 minutes per batch to reach a uniform consistency, and the pour must be finished within 90 minutes of mixing. Scaffolding around the perimeter should be rated for at least 200 kg per platform.",
  },
  {
    id: "syn:plumbing-valve",
    domain: "plumbing",
    origin: "synthetic",
    title: "Choosing a shutoff valve",
    content:
      "A ball valve gives a full-flow, quarter-turn shutoff and is the standard choice for a main water line. Compare it to a gate valve, which throttles more gradually but is more prone to leaks after years of use. Most residential fittings are 15 mm or 22 mm; always match the pipe fitting size exactly, since an adapter at the wrong diameter is the most common cause of a slow leak. The pressure regulator downstream should be set to 3-4 bar for a typical apartment.",
  },
  {
    id: "syn:hvac-heatpump",
    domain: "HVAC",
    origin: "synthetic",
    title: "How an inverter heat pump saves energy",
    content:
      "Unlike a fixed-speed unit, a heat pump with an inverter compressor adjusts its output continuously instead of cycling fully on and off. This keeps the room temperature more stable and can cut electricity use by 20-30% compared to an older non-inverter model. A typical domestic unit has a heating capacity of 8 kW and a COP of 4.1 at 7°C outdoor temperature, dropping to around 2.8 at -7°C.",
  },
  {
    id: "syn:boiler-tank",
    domain: "boilers",
    origin: "synthetic",
    title: "Sizing a boiler for a small apartment",
    content:
      "A combi boiler heats water on demand rather than storing it, which saves space but limits how many taps can run at once. For a two-bedroom apartment, a 24 kW unit is usually enough for both heating and hot water. Annual servicing should include a check of the pressure relief valve and the expansion vessel; the system pressure should sit between 1 and 1.5 bar when cold.",
  },
  {
    id: "syn:ventilation-mvhr",
    domain: "ventilation",
    origin: "synthetic",
    title: "Mechanical ventilation with heat recovery",
    content:
      "A ventilation system with heat recovery extracts stale air from bathrooms and kitchens while supplying fresh air to living rooms and bedrooms, passing both streams through a heat exchanger first. Recovery efficiency on a good unit exceeds 85%. Ductwork should be sized to keep air velocity under 3 m/s to avoid noise, and filters need replacing every 3-6 months depending on local air quality.",
  },
  {
    id: "syn:ac-split-unit",
    domain: "air conditioning",
    origin: "synthetic",
    title: "Split air conditioner installation basics",
    content:
      "The air conditioner has a cooling capacity of 12,000 BTU, suitable for a room up to about 30 m². The indoor and outdoor units are connected by refrigerant lines that must not exceed 15 meters without an additional charge of refrigerant. Installation height for the outdoor unit should allow at least 30 cm of clearance on all sides for airflow.",
  },
  {
    id: "syn:electronics-router",
    domain: "electronics",
    origin: "synthetic",
    title: "What Wi-Fi 7 changes for home networks",
    content:
      "Wi-Fi 7 adds multi-link operation, letting a device use the 2.4 GHz, 5 GHz and 6 GHz bands at the same time for lower latency. Real-world throughput on a good router can exceed 5 Gbps at close range, though most home internet connections will bottleneck well before that. A firmware update to v3.2.1 is recommended before first use to patch a known Wi-Fi Protected Access issue.",
  },
  {
    id: "syn:pc-hardware-gpu",
    domain: "PC hardware",
    origin: "synthetic",
    title: "RTX 5090: what's new",
    content:
      "The RTX 5090 graphics card includes 32 GB of GDDR7 memory and supports PCIe 5.0 for a wider data path between the card and the CPU. Rated power draw is 575 W, so a power supply of at least 1000 W is recommended. The card is 304 mm long and needs three PCIe 8-pin power connectors or a single 16-pin adapter.",
  },
  {
    id: "syn:pc-hardware-storage",
    domain: "PC hardware",
    origin: "synthetic",
    title: "NVMe SSDs and USB4 external storage",
    content:
      "A PCIe 5.0 NVMe SSD can reach sequential read speeds above 12,000 MB/s, roughly double the previous generation. For external storage, USB4 enclosures now support up to 40 Gbps, enough to use an NVMe drive at close to its native speed outside the case. A 2 TB drive typically draws under 8 W under sustained load, so passive cooling is often sufficient.",
  },
  {
    id: "syn:electrical-breaker",
    domain: "electrical equipment",
    origin: "synthetic",
    title: "Choosing a circuit breaker",
    content:
      "A circuit breaker protects a branch circuit from overcurrent by tripping when the load exceeds its rating. A typical kitchen circuit uses a 16 A breaker, while an electric oven circuit is usually 32 A on its own dedicated line. Always match the breaker's trip curve — type B for general household loads, type C for circuits with motors or inrush current — to the equipment it protects, and never bridge a tripped breaker instead of finding the fault.",
  },
  {
    id: "syn:home-improvement-insulation",
    domain: "home improvement",
    origin: "synthetic",
    title: "Attic insulation basics",
    content:
      "Mineral wool insulation laid at 300 mm thickness gives a typical UK loft a U-value of around 0.13 W/m²K, well below current building regulations minimums. Gaps at the eaves and around loft hatches account for a disproportionate share of heat loss, so weatherstripping around the hatch is worth doing even after the main insulation is complete. Wear a mask and gloves when handling mineral wool.",
  },
  {
    id: "syn:home-improvement-window",
    domain: "home improvement",
    origin: "synthetic",
    title: "Resealing a window frame",
    content:
      "Old, cracked caulk around a window frame is one of the most common sources of draughts and water ingress. Remove the old bead completely before applying a new one; silicone sealant does not bond well to itself. A good bead is applied in one continuous pass at a 45-degree angle, then smoothed with a wet finger or tool within about 10 minutes, before a skin forms.",
  },
  {
    id: "syn:hand-tools-wrench",
    domain: "hand tools",
    origin: "synthetic",
    title: "Adjustable wrench vs socket set",
    content:
      "An adjustable wrench is convenient for odd-sized fasteners but grips less securely than a matched socket, and can round off a bolt head if not seated fully square. A basic socket set covering 8-19 mm in metric sizes will cover most household and automotive work. Always turn a torque wrench back down to its lowest setting after use to protect the internal spring.",
  },
  {
    id: "syn:hand-tools-clamp",
    domain: "hand tools",
    origin: "synthetic",
    title: "Clamping technique for glued joints",
    content:
      "A clamp should apply even pressure without crushing the workpiece; too much force can starve a glue joint of adhesive and weaken it. For a typical wood glue, clamping pressure of about 0.7-1.0 MPa is enough, held for at least 30 minutes before light handling and 24 hours before full load. Use scrap wood between the clamp jaws and the workpiece to spread the load and protect the surface.",
  },
  {
    id: "syn:product-desc-vacuum",
    domain: "product descriptions",
    origin: "synthetic",
    title: "Cordless stick vacuum — product listing",
    content:
      "This cordless stick vacuum delivers 180 AW of suction power and runs for up to 60 minutes on a single charge from its 2500 mAh battery pack. The dustbin holds 0.6 liters and empties with a single button, without touching the collected dust. Weight including battery is 2.9 kg. Price: 349.99 BGN, available at https://example.com/store/vacuum-x200.",
  },
  {
    id: "syn:product-desc-monitor",
    domain: "product descriptions",
    origin: "synthetic",
    title: "34-inch curved monitor — product listing",
    content:
      "This 34-inch curved monitor has a 3440x1440 resolution, a 165 Hz refresh rate and a 1ms response time, making it suitable for both office work and gaming. Connectivity includes one DisplayPort 1.4, two HDMI 2.1 ports and a USB-C port with 90 W of power delivery for charging a laptop. Contact sales at sales@example.com for bulk pricing.",
  },
  {
    id: "syn:tech-news-battery",
    domain: "technical news",
    origin: "synthetic",
    title: "Solid-state battery pilot line announced",
    content:
      "A manufacturer has announced a pilot production line for solid-state batteries, targeting an energy density of 500 Wh/kg, roughly double current lithium-ion cells used in electric vehicles. The company says the first commercial cells will ship in limited volume next year, with full-scale production not expected before 2028. Analysts remain cautious, noting that previous solid-state announcements have slipped by several years.",
  },
  {
    id: "syn:tech-news-recall",
    domain: "technical news",
    origin: "synthetic",
    title: "Power bank recall over overheating risk",
    content:
      "A major electronics retailer has recalled roughly 40,000 units of a 20,000 mAh power bank after reports of overheating during charging. The affected batch, identified by serial numbers starting with PB-22, was sold between March and September. Customers are advised to stop using the device immediately and contact support at recall@example.com for a full refund; do not attempt to dispose of the battery in regular household waste.",
  },
  {
    id: "syn:safety-ladder",
    domain: "maintenance/safety",
    origin: "synthetic",
    title: "Ladder safety on site",
    content:
      "A stepladder should be fully open and locked before use, never leaned against a wall like a straight ladder. The 4:1 rule applies to extension ladders: for every 4 units of height, the base should sit 1 unit out from the wall. Inspect rungs and locking mechanisms before every use, and never stand on the top two rungs of a stepladder rated for household use.",
  },
  {
    id: "syn:safety-ppe",
    domain: "maintenance/safety",
    origin: "synthetic",
    title: "Choosing hearing protection for power tools",
    content:
      "Continuous exposure above 85 dB can cause permanent hearing damage over time, and many power tools — angle grinders and circular saws in particular — regularly exceed 100 dB at the operator's ear. Earmuffs rated at SNR 30 are adequate for most site work; foam earplugs offer similar protection but require correct insertion to reach their rated attenuation.",
  },
];

export const EVAL_SAMPLES: EvalSample[] = [
  fromRealFixture("fire-extinguisher", "maintenance/safety"),
  fromRealFixture("power-tools", "power tools"),
  fromRealFixture("sawhorse", "hand tools / construction"),
  ...SYNTHETIC,
];

/**
 * ~35 EN->BG technical terms for the glossary experiment. EXPERIMENTAL EVALUATION ONLY —
 * not vetted for production use. Preferred terms already observed in the project's own
 * fixtures/prior experiment output where available (e.g. "бойлер", "патронник",
 * "шперплат", "акумулаторен" all appear in translation-fixtures.ts or the TranslateGemma
 * experiment's own output). Entries marked `review: true` are less certain and should be
 * checked by a Bulgarian-speaking reviewer before any production use.
 */
export interface GlossaryEntry {
  en: string;
  bg: string;
  review?: boolean;
}

export const GLOSSARY_TERMS: GlossaryEntry[] = [
  // Mandatory terms from the task
  { en: "fire extinguisher", bg: "пожарогасител" },
  { en: "brushless", bg: "безчетков" },
  { en: "brushless motor", bg: "безчетков мотор" },
  { en: "sawhorse", bg: "магаре за рязане" },
  { en: "impact driver", bg: "ударен винтоверт" },
  { en: "heat pump", bg: "термопомпа" },
  { en: "inverter compressor", bg: "инверторен компресор" },

  // Power tools / hand tools
  { en: "drill driver", bg: "бормашина-винтоверт" },
  { en: "cordless", bg: "акумулаторен" },
  { en: "battery pack", bg: "акумулаторна батерия" },
  { en: "chuck", bg: "патронник" },
  { en: "torque wrench", bg: "динамометричен ключ" },
  { en: "angle grinder", bg: "ъглошлайф" },
  { en: "circular saw", bg: "циркуляр" },
  { en: "adjustable wrench", bg: "френски ключ" },
  { en: "clamp", bg: "стяга", review: true },

  // Construction
  { en: "rebar", bg: "армировка" },
  { en: "concrete mixer", bg: "бетонобъркачка" },
  { en: "scaffolding", bg: "скеле" },
  { en: "plywood", bg: "шперплат" },
  { en: "spirit level", bg: "нивелир", review: true },

  // Plumbing
  { en: "ball valve", bg: "сферичен кран", review: true },
  { en: "gate valve", bg: "спирателен кран", review: true },
  { en: "pipe fitting", bg: "фитинг", review: true },
  { en: "pressure regulator", bg: "регулатор на налягането" },
  { en: "water leak", bg: "теч" },

  // HVAC / boilers / ventilation
  { en: "air conditioner", bg: "климатик" },
  { en: "ventilation", bg: "вентилация" },
  { en: "ductwork", bg: "въздуховоди", review: true },
  { en: "thermostat", bg: "термостат" },
  { en: "boiler", bg: "бойлер" },
  { en: "expansion vessel", bg: "разширителен съд", review: true },

  // Electrical
  { en: "circuit breaker", bg: "предпазен прекъсвач", review: true },
  { en: "surge protector", bg: "предпазител от пренапрежение", review: true },
  { en: "grounding", bg: "заземяване" },

  // PC hardware / electronics
  { en: "graphics card", bg: "видеокарта" },
  { en: "motherboard", bg: "дънна платка" },
  { en: "power supply", bg: "захранващ блок" },
  { en: "solid-state drive", bg: "SSD диск", review: true },
  { en: "memory module", bg: "модул памет" },
  { en: "router", bg: "рутер" },
  { en: "firmware update", bg: "актуализация на фърмуера" },

  // Home improvement
  { en: "insulation", bg: "изолация" },
  { en: "weatherstripping", bg: "уплътнение за прозорци и врати", review: true },
  { en: "caulk", bg: "силиконов уплътнител", review: true },
];
