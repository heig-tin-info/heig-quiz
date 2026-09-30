import type { FastifyInstance } from "fastify";

/**
 * A value kept per application in memory, readable from any of its plugin
 * contexts. A plugin registered without `fastify-plugin` receives a CHILD
 * instance (`Object.create(parent)`), so a plain `WeakMap` keyed on the root
 * misses it: the admin routes read the ticker's lag and the server errors
 * through their own child. `get` walks up to the instance that was set.
 */
export function perApp<T>() {
  const values = new WeakMap<object, T>();
  return {
    set(app: FastifyInstance, value: T): void {
      values.set(app, value);
    },
    get(app: FastifyInstance): T | undefined {
      for (let at: object | null = app; at !== null; at = Object.getPrototypeOf(at) as object | null) {
        const value = values.get(at);
        if (value !== undefined) return value;
      }
      return undefined;
    },
  };
}
