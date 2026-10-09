/**
 * How the staff's readers of the `live` module name a person: "Given Family",
 * or the fallback (an e-mail) when both are blank.
 */
export function fullName(given: string | null, family: string | null, fallback: string): string {
  return `${given ?? ""} ${family ?? ""}`.trim() || fallback;
}
