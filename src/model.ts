import type { CursorModelParameter } from "./domain/configuration.js";

export interface CursorModelVariantLike {
  params: readonly CursorModelParameter[];
  isDefault?: boolean;
}

export interface CursorModelLike {
  id: string;
  displayName: string;
  variants?: readonly CursorModelVariantLike[];
}

export interface CursorModelSelection {
  id: string;
  params?: CursorModelParameter[];
}

function sameParameters(
  left: readonly CursorModelParameter[],
  right: readonly CursorModelParameter[],
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((parameter) => [parameter.id, parameter.value]));
  return left.every((parameter) => rightById.get(parameter.id) === parameter.value);
}

export function chooseConfiguredGrok<T extends CursorModelLike>(
  models: readonly T[],
  configuredId: string,
  configuredParams: readonly CursorModelParameter[] = [],
): CursorModelSelection {
  const selected = models.find((model) => model.id === configuredId);
  if (!selected) throw new Error(`Configured Cursor model is unavailable: ${configuredId}`);
  if (!`${selected.id} ${selected.displayName}`.toLowerCase().includes("grok")) {
    throw new Error(`Configured Cursor model is not a Grok model: ${configuredId}`);
  }
  if (configuredParams.length === 0) {
    return {
      id: selected.id,
      params: modelParamsForEffort(selected, "high", { fast: false }),
    };
  }
  const variant = selected.variants?.find((candidate) =>
    sameParameters(candidate.params, configuredParams)
  );
  if (!variant) {
    throw new Error(`Configured Cursor model variant is unavailable: ${configuredId}`);
  }
  return { id: selected.id, params: configuredParams.map((parameter) => ({ ...parameter })) };
}

export function modelParamsForEffort(
  model: CursorModelLike,
  effort: string,
  options: { fast?: boolean } = {},
): CursorModelParameter[] {
  const matches = model.variants?.filter((variant) =>
    variant.params.some((parameter) => parameter.id === "effort" && parameter.value === effort)
    && (options.fast === undefined || variant.params.some((parameter) =>
      parameter.id === "fast" && parameter.value === String(options.fast)
    ))
  ) ?? [];
  const selected = matches.find((variant) => variant.isDefault) ?? matches[0];
  if (!selected) {
    const fastConstraint = options.fast === undefined ? "" : ` with fast=${options.fast}`;
    throw new Error(`Cursor model ${model.id} does not support ${effort} effort${fastConstraint}`);
  }
  return selected.params.map((parameter) => ({ ...parameter }));
}
