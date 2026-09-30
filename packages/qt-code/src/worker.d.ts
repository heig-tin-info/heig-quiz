/**
 * Vite's `?worker` import (`./monacoBundle.ts`): the default export starts the
 * module as a Web Worker served from the build. The package is compiled by
 * `tsc`; the suffix is resolved by the application's Vite build.
 */
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
