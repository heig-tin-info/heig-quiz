import { AlertTriangle, Plus } from "lucide-react";
import { useId, useState } from "react";

import { ProjectPatch, type ProjectSourceDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { Alert, Button, Checkbox, Chip, Field, FieldError, fieldErrorProps } from "../ui";

/** The grading workflow, which unchecking warns about (F-PROJ-01). */
const GRADING_WORKFLOW = ".github/workflows/grading.yml";

/** The files, not the directories, of a source's tree: the completions of an added path. */
export const sourceFiles = (source: ProjectSourceDetail | undefined): string[] =>
  (source?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);

/**
 * A project's protected files (F-PROJ-01, F-PROJ-08): the suggestions the
 * source holds (`suggestedProtected`), each a checkbox, then any other file
 * of the source the teacher adds by its path — a lab's `tests/`, `Makefile`,
 * which the evidence run also takes from the distribution (ADR-106 §3). An
 * added path is a removable chip; it is checked by the contract's own rule
 * (`ProtectedPath`: relative, no `..`; at most 50) before it reaches the list, and the
 * source's files (`files`, its tree) are offered as completions. A path the
 * source does not hold is accepted: it is simply never restored. Unchecking
 * `grading.yml` warns that the student could then alter the grading. The
 * new project's form draws it, and the project page's settings (M3-12).
 */
export function ProtectedFiles({
  suggested,
  value,
  onChange,
  files,
}: {
  suggested: readonly string[];
  value: readonly string[];
  onChange: (files: string[]) => void;
  /** The source's files, offered as completions of the added path. */
  files: readonly string[];
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = (path: string, on: boolean) =>
    onChange(on ? [...value, path] : value.filter((p) => p !== path));
  const added = value.filter((p) => !suggested.includes(p));
  const offered = files.filter((p) => !value.includes(p));

  /** Adds `raw` once, if the contract's own rule takes it (relative, no `..`, at most 50 files). */
  const add = (raw: string) => {
    const path = raw.trim();
    if (!path) return;
    if (!value.includes(path)) {
      const next = [...value, path];
      if (!ProjectPatch.shape.protectedFiles.safeParse(next).success) return setError(t("project.protected.add.invalid"));
      onChange(next);
    }
    setDraft("");
  };

  return (
    <div className="space-y-3">
      {suggested.length > 0 ? (
        <div className="flex flex-col gap-2">
          {suggested.map((path) => (
            <Checkbox
              key={path}
              label={<span className="font-mono text-[13px]">{path}</span>}
              checked={value.includes(path)}
              onChange={(e) => toggle(path, e.target.checked)}
            />
          ))}
        </div>
      ) : null}
      {added.length > 0 ? (
        <ul className="flex flex-wrap gap-2 font-mono" aria-label={t("project.protected.added")}>
          {added.map((path) => (
            <li key={path}>
              <Chip label={path} remove={t("project.protected.remove")} onRemove={() => toggle(path, false)} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <Field
          id={id}
          size="sm"
          width="w-full max-w-sm"
          className="font-mono"
          label={t("project.protected.add.label")}
          placeholder="tests/test_lab.py"
          autoComplete="off"
          spellCheck={false}
          list={offered.length > 0 ? `${id}-files` : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Inside the new project's form, Enter adds the path, never submits;
            // it reads the input itself, which a completion picked by Enter
            // has already filled, and leaves an IME composition alone.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add(e.currentTarget.value);
            }
          }}
          {...fieldErrorProps(id, error)}
        />
        <Button type="button" variant="ghost" size="sm" disabled={!draft.trim()} onClick={() => add(draft)}>
          <Plus />
          {t("project.protected.add")}
        </Button>
      </div>
      <FieldError id={id}>{error}</FieldError>
      {offered.length > 0 ? (
        <datalist id={`${id}-files`}>
          {offered.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      ) : null}
      {suggested.includes(GRADING_WORKFLOW) && !value.includes(GRADING_WORKFLOW) ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.protected.gradingWarning")} />
      ) : null}
    </div>
  );
}
