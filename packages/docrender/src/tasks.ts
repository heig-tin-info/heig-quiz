/**
 * Task lists of a journal page (`- [x] …`), read as a course plan: an item is
 * a topic, a tick says it was covered. A parent's state is DERIVED from its
 * sub-tasks, so the author ticks the leaves and the chapters follow:
 *
 * - `done`: ticked in the markdown, or every sub-task done;
 * - `doing`: not done, but some sub-task is ticked (or itself in progress);
 * - `todo`: nothing ticked below it.
 *
 * The count is over the leaves below the item (`3/5`); a parent ticked by
 * hand counts all its leaves as covered, as its state says.
 */
import type { Tokens } from "marked";

export type TaskState = "done" | "doing" | "todo";

export interface TaskTally {
  state: TaskState;
  /** Leaves covered, and leaves in all; both 0 for a leaf. */
  done: number;
  total: number;
}

/** The task items of the lists directly inside `item` (a nested list is a direct token of its item). */
function subTasks(item: Tokens.ListItem): Tokens.ListItem[] {
  return item.tokens
    .filter((t): t is Tokens.List => t.type === "list")
    .flatMap((list) => list.items.filter((i) => i.task));
}

export function taskTally(item: Tokens.ListItem): TaskTally {
  const own = item.checked === true;
  const kids = subTasks(item).map(taskTally);
  if (kids.length === 0) return { state: own ? "done" : "todo", done: 0, total: 0 };

  let done = 0;
  let total = 0;
  for (const k of kids) {
    const leaf = k.total === 0;
    total += leaf ? 1 : k.total;
    done += leaf ? (k.state === "done" ? 1 : 0) : k.done;
  }
  const allDone = kids.every((k) => k.state === "done");
  if (own || allDone) return { state: "done", done: total, total };
  const started = kids.some((k) => k.state !== "todo");
  return { state: started ? "doing" : "todo", done, total };
}
