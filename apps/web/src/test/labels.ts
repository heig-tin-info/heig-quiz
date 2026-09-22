/*
 * One assertion, for every screen: a `<label for>` must point at a control
 * the browser can actually associate with it.
 *
 * Chrome reports both failures under the same heading in its Issues panel —
 * "Incorrect use of <label for=FORM_ELEMENT>: The label's for attribute
 * doesn't match any element id" — and both cost the same thing: the control
 * loses its accessible name, and clicking the caption does nothing.
 *
 * The second failure is the one a rich editor walks into. A `<label>` can
 * only address a LABELABLE element, and the editing surface of `RichText` is
 * a contenteditable `<div>`: a `for` pointing at it matches an element and
 * still names no control. Such a field wears a caption (`<span>`) and takes
 * its name from `aria-label` instead.
 */

/** https://html.spec.whatwg.org/multipage/forms.html#category-label */
const LABELABLE = new Set([
  "BUTTON",
  "INPUT",
  "METER",
  "OUTPUT",
  "PROGRESS",
  "SELECT",
  "TEXTAREA",
]);

/** One line per `<label for>` that names no control, empty when all of them do. */
export function labelIssues(root: ParentNode = document): string[] {
  const issues: string[] = [];
  for (const label of root.querySelectorAll("label[for]")) {
    const target = label.getAttribute("for") ?? "";
    const caption = (label.textContent ?? "").trim().slice(0, 40);
    const element = label.ownerDocument.getElementById(target);
    if (element === null) {
      issues.push(`<label for="${target}"> ("${caption}") matches no element id`);
    } else if (!LABELABLE.has(element.tagName)) {
      issues.push(
        `<label for="${target}"> ("${caption}") points at <${element.tagName.toLowerCase()}>, which is not a labelable element`,
      );
    }
  }
  return issues;
}
