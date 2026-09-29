/**
 * Monaco, bundled from the installed `monaco-editor` and served from our own
 * origin (N-SEC-02: no CDN, so the CSP needs no third-party source).
 *
 * Only what the code editor uses: the editor core with its contributions
 * (`edcore.main`, which is `editor.main` without the ~80 languages and the
 * TypeScript/CSS/HTML/JSON language services) and the Monarch grammars of the
 * languages a `code` question offers (`MONACO_LANGUAGE`; C is in `cpp`).
 *
 * Loaded only through `LazyMonaco`'s dynamic import, so none of it enters a
 * chunk until a code editor renders. The one worker (diffs, word suggestions,
 * link detection) is a file of the build, started by URL: `worker-src 'self'`.
 */
import "monaco-editor/esm/vs/editor/edcore.main.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";

(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
