/**
 * Runs `fn` after every earlier call of the same key has settled. In memory:
 * the portal is one process. Its users: one review opening at a time per
 * staff member (ADR-129 §1), one collection at a time, one fetch of the
 * teacher's update at a time per staging repository (ADR-132 §11).
 */
export function serializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
