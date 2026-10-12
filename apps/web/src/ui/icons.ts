import { createLucideIcon } from "lucide-react";

/**
 * A classroom: a board and the group of students in front of it. lucide's
 * `School` is a building, which reads as an institution rather than a class;
 * it stays the mark of the teacher role and view. Drawn on lucide's grid
 * (24×24, 2 px stroke, round caps and joins), so it sizes and colours like
 * any other icon.
 */
export const ClassroomIcon = createLucideIcon("classroom", [
  ["rect", { x: "3", y: "2", width: "18", height: "9", rx: "1", key: "board" }],
  ["path", { d: "M7 6h6", key: "chalk" }],
  ["circle", { cx: "12", cy: "15", r: "2.2", key: "head" }],
  ["path", { d: "M7.5 22a4.5 4.5 0 0 1 9 0", key: "body" }],
  ["circle", { cx: "5.5", cy: "16.5", r: "1.5", key: "head-left" }],
  ["circle", { cx: "18.5", cy: "16.5", r: "1.5", key: "head-right" }],
  [
    "path",
    { d: "M2.5 22a3 3 0 0 1 4-2.8M21.5 22a3 3 0 0 0-4-2.8", key: "bodies" },
  ],
]);
