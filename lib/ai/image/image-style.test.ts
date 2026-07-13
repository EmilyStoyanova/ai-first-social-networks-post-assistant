import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateImageRequestSchema, imageStyleSchema } from "./image-style";

describe("image style validation", () => {
  it("accepts each supported style", () => {
    for (const style of ["default", "realistic", "animated"]) {
      assert.ok(imageStyleSchema.safeParse(style).success, `${style} should be valid`);
    }
  });

  it("rejects arbitrary / unsupported values", () => {
    assert.ok(!imageStyleSchema.safeParse("cinematic").success);
    assert.ok(!imageStyleSchema.safeParse("REALISTIC").success);
    assert.ok(!imageStyleSchema.safeParse("").success);
    assert.ok(!imageStyleSchema.safeParse(123).success);
  });

  it("treats imageStyle as optional on the request body", () => {
    assert.ok(generateImageRequestSchema.safeParse({}).success);
    assert.deepEqual(generateImageRequestSchema.parse({}), {});
    assert.deepEqual(generateImageRequestSchema.parse({ imageStyle: "animated" }), {
      imageStyle: "animated",
    });
  });

  it("rejects an invalid imageStyle on the request body", () => {
    assert.ok(!generateImageRequestSchema.safeParse({ imageStyle: "watercolor" }).success);
  });
});
