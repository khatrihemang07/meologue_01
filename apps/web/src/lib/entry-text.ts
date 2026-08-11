/** Trims an Entry draft and rejects it if that leaves nothing behind. */
export function normalizeEntryBody(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
