/**
 * Initials for the header's account avatar.
 *
 * Pure and dependency-free so the fallback chain is unit-testable — the avatar
 * is the only identity the compacted header shows, so "what appears when the
 * name is missing, blank, or an email address" is behaviour worth pinning down
 * rather than inlining in JSX.
 *
 * The chain, in order:
 *   1. a display name        — first letter of the first two words ("Ada L" → "AL")
 *   2. an email address      — first letter of the local part ("ada@x.io" → "A")
 *   3. neither               — `null`, so the caller renders a generic user icon
 *
 * Non-Latin scripts are handled by the same rule: this takes the first
 * character of a word, whatever alphabet it is in ("Емили Стоянова" → "ЕС").
 */
export function userInitials(name?: string | null, email?: string | null): string | null {
  const trimmedName = name?.trim();
  if (trimmedName) {
    const words = trimmedName.split(/\s+/).filter(Boolean);
    const initials = words
      .slice(0, 2)
      // `Array.from` rather than `[0]`: a surrogate-pair character would be cut
      // in half by index access and render as a replacement glyph.
      .map((word) => Array.from(word)[0] ?? "")
      .join("");
    if (initials) return initials.toLocaleUpperCase();
  }

  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    const local = trimmedEmail.split("@")[0];
    const first = Array.from(local ?? "")[0];
    if (first) return first.toLocaleUpperCase();
  }

  return null;
}
