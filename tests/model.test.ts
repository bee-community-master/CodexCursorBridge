import { describe, expect, it } from "vitest";
import {
  chooseConfiguredGrok,
  modelParamsForEffort,
} from "../src/model.js";

const models = [
  { id: "grok-4", displayName: "Grok 4" },
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    variants: [
      {
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ],
        displayName: "Grok 4.5 High",
      },
      {
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        displayName: "Grok 4.5 High Fast",
        isDefault: true,
      },
    ],
  },
];

describe("Cursor model selection", () => {
  it("requires the configured exact model id", () => {
    expect(chooseConfiguredGrok(models, "grok-4.5").id).toBe("grok-4.5");
    expect(() => chooseConfiguredGrok(models, "grok-latest")).toThrow(/unavailable/i);
  });

  it("selects and validates the default high-effort variant", () => {
    const params = modelParamsForEffort(models[1]!, "high");
    expect(params).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
    expect(chooseConfiguredGrok(models, "grok-4.5", params)).toEqual({
      id: "grok-4.5",
      params,
    });
    expect(() => chooseConfiguredGrok(models, "grok-4.5", [
      { id: "effort", value: "medium" },
    ])).toThrow(/variant/i);
  });

  it("fails closed when the selected Grok model has no requested effort", () => {
    expect(() => modelParamsForEffort(models[0]!, "high")).toThrow(/high/i);
  });

  it("rejects a configured non-Grok model", () => {
    expect(() => chooseConfiguredGrok([{ id: "other", displayName: "Other" }], "other")).toThrow(/Grok/i);
  });
});
