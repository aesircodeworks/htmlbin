// Tiny cookie reader shared by the viewer (unlock cookies) and the GitHub
// sign-in (browser binding cookie).
export function getCookie(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}
