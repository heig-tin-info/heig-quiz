/**
 * The training course of a new teacher (ADR-105, F-ORG-17): one course per
 * teacher, provisioned on request, and a progress card whose lines are derived
 * from the data, never stored.
 */
import { z } from "zod";

/** The four missions, in the order the card shows them. The fourth is optional. */
export const TRAINING_MISSIONS = ["student", "run", "own", "tools"] as const;
export type TrainingMission = (typeof TRAINING_MISSIONS)[number];

export const TrainingMissionState = z.enum(["todo", "done", "unavailable"]);
export type TrainingMissionState = z.infer<typeof TrainingMissionState>;

/** `GET /app/api/training`. */
export const TrainingStatus = z.object({
  /** The public training pool exists: an admin ran the `training.install` task. */
  installed: z.boolean(),
  /** The caller's training course, or null until they provision it. */
  course: z
    .object({
      id: z.string().uuid(),
      classroomId: z.string().uuid(),
    })
    .nullable(),
  /** One entry per mission of `TRAINING_MISSIONS`, in that order. */
  missions: z.array(
    z.object({
      key: z.enum(TRAINING_MISSIONS),
      state: TrainingMissionState,
    }),
  ),
});
export type TrainingStatus = z.infer<typeof TrainingStatus>;

/** `POST /app/api/training`: provisions the caller's course, or returns the existing one. */
export const TrainingProvisionResponse = z.object({
  courseId: z.string().uuid(),
  classroomId: z.string().uuid(),
  created: z.boolean(),
});
export type TrainingProvisionResponse = z.infer<typeof TrainingProvisionResponse>;

/** What the `training.install` admin task reports. */
export const TrainingInstallResult = z.object({
  poolId: z.string().uuid(),
  questions: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
});
export type TrainingInstallResult = z.infer<typeof TrainingInstallResult>;
