/**
 * HTML the server writes itself (the mails, the development login page):
 * the escaping of what it puts in.
 */

/** The five characters that matter in text and in a quoted attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
