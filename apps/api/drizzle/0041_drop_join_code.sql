-- ADR-053: the classroom join code (F-ORG-06) is removed. Students enter a roster
-- only through the teacher and are matched at sign-in (auth/claims.ts). Destructive:
-- an image older than this migration selects these columns and cannot run against it.
ALTER TABLE "classrooms" DROP CONSTRAINT "classrooms_join_code_unique";--> statement-breakpoint
ALTER TABLE "classrooms" DROP COLUMN "join_code";--> statement-breakpoint
ALTER TABLE "classrooms" DROP COLUMN "join_code_enabled";
