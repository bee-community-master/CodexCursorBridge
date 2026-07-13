import { describe, expect, it } from "vitest";
import { chooseConfiguredGrok } from "../src/model.js";

const models = [
  { id: "grok-4", displayName: "Grok 4" },
  { id: "grok-4.5", displayName: "Grok 4.5" },
];

describe("Cursor model selection", () => {
  it("requires the configured exact model id", () => {
    expect(chooseConfiguredGrok(models, "grok-4.5").id).toBe("grok-4.5");
    expect(() => chooseConfiguredGrok(models, "grok-latest")).toThrow(/unavailable/i);
  });

  it("rejects a configured non-Grok model", () => {
    expect(() => chooseConfiguredGrok([{ id: "other", displayName: "Other" }], "other")).toThrow(/Grok/i);
  });
});
