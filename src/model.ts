export interface CursorModelLike {
  id: string;
  displayName: string;
}

export function chooseConfiguredGrok<T extends CursorModelLike>(models: readonly T[], configuredId: string): T {
  const selected = models.find((model) => model.id === configuredId);
  if (!selected) throw new Error(`Configured Cursor model is unavailable: ${configuredId}`);
  if (!`${selected.id} ${selected.displayName}`.toLowerCase().includes("grok")) {
    throw new Error(`Configured Cursor model is not a Grok model: ${configuredId}`);
  }
  return selected;
}
