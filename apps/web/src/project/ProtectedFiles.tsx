import { AlertTriangle } from "lucide-react";

import { useT } from "../i18n";
import { Alert, Checkbox } from "../ui";

/** The grading workflow, which unchecking warns about (F-PROJ-01). */
const GRADING_WORKFLOW = ".github/workflows/grading.yml";

/**
 * A project's protected files (F-PROJ-01): the suggestions the source holds
 * (`suggestedProtected`), each a checkbox. Unchecking `grading.yml` warns
 * that the student could then alter the grading. The new project's form
 * draws it, and the project page's settings (M3-12), where `suggested` also
 * carries the files protected today that the source no longer suggests.
 */
export function ProtectedFiles({
  suggested,
  value,
  onChange,
}: {
  suggested: readonly string[];
  value: readonly string[];
  onChange: (files: string[]) => void;
}) {
  const t = useT();
  const toggle = (path: string, on: boolean) =>
    onChange(on ? [...value, path] : value.filter((p) => p !== path));
  return (
    <div className="space-y-3">
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
      {suggested.includes(GRADING_WORKFLOW) && !value.includes(GRADING_WORKFLOW) ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.protected.gradingWarning")} />
      ) : null}
    </div>
  );
}
