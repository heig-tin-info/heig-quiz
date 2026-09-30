/**
 * The pages of the classroom merge (ADR-035, `docs/merge/05-web.md` §5.1–§5.2)
 * whose routes exist before their screens do: the student's Courses and
 * classroom page, the classroom's Settings, Journal and Grades tabs, the
 * project pages. Each renders a placeholder until its task ships the real
 * screen (M2-07, M4-04, M5-02, M5-04, M3-12).
 *
 * Off in a production build: those routes do not parse — every such address
 * reads exactly as it did before them — and a student on `/classrooms/:id`
 * still lands on the home. On in the browser mock (`VITE_MOCK=1`), and
 * wherever `VITE_CLASSROOM_PAGES=1` is set at build time. A route leaves the
 * flag (its `preview` in `router.ts`) in the PR that ships its screen; the
 * student branch of `classroom` leaves it with M5-02.
 */
export const CLASSROOM_PAGES =
  import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_CLASSROOM_PAGES === "1";
