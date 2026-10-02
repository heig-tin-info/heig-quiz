import type { ReactNode } from "react";

import { ErrorText } from "../ui";
import type { ProjectField } from "./newProject";

/** The DOM id of the control each message of the new project form stands under. */
export const FIELD_ID: Record<ProjectField, string> = {
  name: "project-name",
  source: "project-source",
  start: "project-start",
  deadline: "project-deadline",
  duration: "project-duration-days",
  grace: "project-grace",
  groupMaxSize: "project-group-max",
};

/** `aria-invalid` and the message's id, for a control with a message under it. */
export function invalidProps(field: ProjectField, message: string | undefined) {
  return message ? { "aria-invalid": true, "aria-describedby": `${FIELD_ID[field]}-error` } : {};
}

/** The message under a control, tied to it by `aria-describedby`; nothing without one. */
export function FieldMessage({ field, children }: { field: ProjectField; children: ReactNode }) {
  return children ? <ErrorText id={`${FIELD_ID[field]}-error`}>{children}</ErrorText> : null;
}
