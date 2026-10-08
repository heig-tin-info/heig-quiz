import type { CourseSummary } from "@quiz/contracts";

import { PoolIcon } from "../pool/PoolIcon";
import { DEFAULT_COURSE_ICON } from "../pool/poolIcons";

/**
 * A course's icon: a pool's icon and colour (`PoolIcon`), with a cap rather
 * than a shelf when none was picked, so a course never reads as a pool.
 */
export function CourseIcon({
  course,
  className,
}: {
  course: Pick<CourseSummary, "icon" | "color">;
  className?: string;
}) {
  return (
    <PoolIcon icon={course.icon} color={course.color} fallback={DEFAULT_COURSE_ICON} className={className} />
  );
}
