import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  updateBrandGuidelines,
  type BrandGuidelinesData,
  type UpdateBrandGuidelinesDeps,
} from "./update-brand-guidelines.service";
import { resolveTopicPriorities } from "@/lib/ai/topic-priorities";
import type { UpdateBrandGuidelinesInput } from "@/lib/validators/brand-guidelines.schema";

// The service is orchestration over two seams — "who may write here" and "write
// it". Injecting both is what lets the authorization outcomes and the saved
// payload be asserted without a database.

type Saved = { companyId: string; data: UpdateBrandGuidelinesInput };

function row(companyId: string, data: UpdateBrandGuidelinesInput): BrandGuidelinesData {
  return {
    id: "brand-1",
    companyId,
    logoUrl: null,
    primaryColor: null,
    secondaryColor: null,
    fontFamily: null,
    toneOfVoice: null,
    companyDescription: null,
    targetAudience: null,
    forbiddenWords: data.forbiddenWords ?? [],
    competitors: data.competitors ?? [],
    topPriorityTopics: data.topPriorityTopics ?? [],
    mediumPriorityTopics: data.mediumPriorityTopics ?? [],
    avoidedTopics: data.avoidedTopics ?? [],
    createdAt: new Date("2026-08-17T00:00:00Z"),
    updatedAt: new Date("2026-08-17T00:00:00Z"),
  };
}

/** A store that persists one company's brand row, so a save can be read back. */
function makeDeps(access: Awaited<ReturnType<UpdateBrandGuidelinesDeps["resolveAccess"]>>) {
  const saves: Saved[] = [];
  const store = new Map<string, BrandGuidelinesData>();

  const deps: UpdateBrandGuidelinesDeps = {
    resolveAccess: async () => access,
    persist: async (companyId, data) => {
      saves.push({ companyId, data });
      const previous = store.get(companyId);
      const next = row(companyId, data);
      // An omitted group keeps what is stored — the same thing Prisma's
      // `undefined` means in an update.
      if (previous) {
        next.topPriorityTopics = data.topPriorityTopics ?? previous.topPriorityTopics;
        next.mediumPriorityTopics = data.mediumPriorityTopics ?? previous.mediumPriorityTopics;
        next.avoidedTopics = data.avoidedTopics ?? previous.avoidedTopics;
      }
      store.set(companyId, next);
      return next;
    },
  };

  return { deps, saves, store };
}

const OWNER = { ok: true, companyId: "company-1" } as const;

const TOPICS: UpdateBrandGuidelinesInput = {
  topPriorityTopics: ["бои", "смесители и аксесоари за баня", "бойлери"],
  mediumPriorityTopics: ["вентилация", "климатизация", "конвектори"],
  avoidedTopics: ["камини", "тухли", "грубо строителство"],
};

describe("updateBrandGuidelines — topic priorities", () => {
  it("saves all three lists and returns them", async () => {
    const { deps, saves } = makeDeps(OWNER);

    const result = await updateBrandGuidelines("domestico", "user-1", false, TOPICS, deps);

    assert.equal(result.success, true);
    assert.ok(result.success);
    assert.deepEqual(result.brandGuidelines.topPriorityTopics, TOPICS.topPriorityTopics);
    assert.deepEqual(result.brandGuidelines.mediumPriorityTopics, TOPICS.mediumPriorityTopics);
    assert.deepEqual(result.brandGuidelines.avoidedTopics, TOPICS.avoidedTopics);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].companyId, "company-1");
  });

  it("loads back exactly what was saved", async () => {
    const { deps, store } = makeDeps(OWNER);
    await updateBrandGuidelines("domestico", "user-1", false, TOPICS, deps);

    const stored = store.get("company-1");
    assert.deepEqual(resolveTopicPriorities(stored), {
      high: TOPICS.topPriorityTopics,
      medium: TOPICS.mediumPriorityTopics,
      avoided: TOPICS.avoidedTopics,
    });
  });

  it("saves empty lists as the default configuration", async () => {
    const { deps, store } = makeDeps(OWNER);
    await updateBrandGuidelines(
      "domestico",
      "user-1",
      false,
      { topPriorityTopics: [], mediumPriorityTopics: [], avoidedTopics: [] },
      deps
    );

    assert.deepEqual(resolveTopicPriorities(store.get("company-1")), {
      high: [],
      medium: [],
      avoided: [],
    });
  });

  it("clears a group when an empty list is submitted for it", async () => {
    const { deps, store } = makeDeps(OWNER);
    await updateBrandGuidelines("domestico", "user-1", false, TOPICS, deps);
    await updateBrandGuidelines(
      "domestico",
      "user-1",
      false,
      { ...TOPICS, avoidedTopics: [] },
      deps
    );

    assert.deepEqual(store.get("company-1")?.avoidedTopics, []);
    assert.deepEqual(store.get("company-1")?.topPriorityTopics, TOPICS.topPriorityTopics);
  });

  it("leaves a group alone when the payload omits it", async () => {
    // A save from a client that does not know about topics must not wipe them.
    const { deps, store } = makeDeps(OWNER);
    await updateBrandGuidelines("domestico", "user-1", false, TOPICS, deps);
    await updateBrandGuidelines("domestico", "user-1", false, { toneOfVoice: "Friendly" }, deps);

    assert.deepEqual(store.get("company-1")?.topPriorityTopics, TOPICS.topPriorityTopics);
    assert.deepEqual(store.get("company-1")?.avoidedTopics, TOPICS.avoidedTopics);
  });

  it("resolves an unconfigured company to empty lists", async () => {
    // Nothing was ever saved, so there is no row at all.
    assert.deepEqual(resolveTopicPriorities(null), { high: [], medium: [], avoided: [] });
  });
});

describe("updateBrandGuidelines — authorization", () => {
  it("saves for a company owner", async () => {
    const { deps, saves } = makeDeps(OWNER);
    const result = await updateBrandGuidelines("domestico", "owner-1", false, TOPICS, deps);
    assert.equal(result.success, true);
    assert.equal(saves.length, 1);
  });

  it("saves for a global admin", async () => {
    const { deps, saves } = makeDeps({ ok: true, companyId: "company-1" });
    const result = await updateBrandGuidelines("domestico", "admin-1", true, TOPICS, deps);
    assert.equal(result.success, true);
    assert.equal(saves.length, 1);
  });

  it("refuses an editor and writes nothing", async () => {
    const { deps, saves } = makeDeps({ ok: false, code: "FORBIDDEN" });
    const result = await updateBrandGuidelines("domestico", "editor-1", false, TOPICS, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.equal(saves.length, 0);
  });

  it("refuses a non-member with NOT_FOUND and writes nothing", async () => {
    // NOT_FOUND rather than FORBIDDEN: "you may not" would confirm the company
    // exists to somebody with no relationship to it.
    const { deps, saves } = makeDeps({ ok: false, code: "NOT_FOUND" });
    const result = await updateBrandGuidelines("domestico", "outsider", false, TOPICS, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.equal(saves.length, 0);
  });

  it("writes to the company the access check resolved, never to the slug", async () => {
    const { deps, saves } = makeDeps({ ok: true, companyId: "company-resolved" });
    await updateBrandGuidelines("some-slug", "owner-1", false, TOPICS, deps);
    assert.equal(saves[0].companyId, "company-resolved");
  });
});

describe("updateBrandGuidelines — existing brand fields", () => {
  it("still passes the pre-existing fields through to the store", async () => {
    const { deps, saves } = makeDeps(OWNER);
    await updateBrandGuidelines(
      "domestico",
      "owner-1",
      false,
      {
        automationMode: "fully_automated",
        defaultLang: "bg",
        toneOfVoice: "Professional",
        forbiddenWords: ["cheap"],
        competitors: ["Competitor A"],
      },
      deps
    );

    assert.deepEqual(saves[0].data.forbiddenWords, ["cheap"]);
    assert.deepEqual(saves[0].data.competitors, ["Competitor A"]);
    assert.equal(saves[0].data.automationMode, "fully_automated");
    assert.equal(saves[0].data.defaultLang, "bg");
  });
});
