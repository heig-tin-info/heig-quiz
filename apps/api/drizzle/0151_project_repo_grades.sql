-- The grading columns of `project_repos` move to `project_repo_grades`
-- (database remediation, Phase 4, EXPAND step; F5, F7). Additive: the old
-- columns stay, the code reads and writes the new table only, and two
-- triggers keep both copies equal so that a rollback to an older image reads
-- and writes current values, and the roll-forward after it finds them. The
-- contract step (a later migration, after a week in production and a fresh
-- dump) drops the triggers, their functions and the old columns.
--
-- Points become unconstrained `numeric`: exact. A float8 holding at most 15
-- significant digits (production: at most two decimals, at most 100) casts
-- to numeric exactly; a value the code writes in the new table is copied to
-- float8 for the old image and never copied back (`pg_trigger_depth`), so it
-- is never rounded.
--
-- Verification (the plan's "Verify" step), read-only: zero rows when the old
-- columns and the new table agree. A points column agrees when the old float8
-- cast to numeric is the new value (the backfill and an older image's write),
-- or the new value cast to float8 is the old one (the code's write, whose
-- numeric may carry more digits than a float8 cast to numeric keeps). A row
-- of the new table with no value at all is reported too.
--
--   SELECT r.id
--   FROM project_repos r
--   LEFT JOIN project_repo_grades g ON g.repo_id = r.id
--   WHERE NOT (
--         (r.teacher_points::numeric IS NOT DISTINCT FROM g.teacher_points OR r.teacher_points IS NOT DISTINCT FROM g.teacher_points::float8)
--     AND (r.teacher_max::numeric IS NOT DISTINCT FROM g.teacher_max OR r.teacher_max IS NOT DISTINCT FROM g.teacher_max::float8)
--     AND (r.grade_adjust_value::numeric IS NOT DISTINCT FROM g.grade_adjust_value OR r.grade_adjust_value IS NOT DISTINCT FROM g.grade_adjust_value::float8)
--     AND (r.grade_adjust_base::numeric IS NOT DISTINCT FROM g.grade_adjust_base OR r.grade_adjust_base IS NOT DISTINCT FROM g.grade_adjust_base::float8)
--     AND (r.released_points::numeric IS NOT DISTINCT FROM g.released_points OR r.released_points IS NOT DISTINCT FROM g.released_points::float8)
--     AND (r.released_max::numeric IS NOT DISTINCT FROM g.released_max OR r.released_max IS NOT DISTINCT FROM g.released_max::float8)
--     AND (r.released_grade::numeric IS NOT DISTINCT FROM g.released_grade OR r.released_grade IS NOT DISTINCT FROM g.released_grade::float8)
--     AND ROW(r.teacher_comment, r.teacher_graded_by, r.teacher_graded_at,
--             r.grade_adjust_kind, r.grade_adjust_comment, r.grade_adjusted_by, r.grade_adjusted_at,
--             r.released_comment, r.released_adjustment_comment)
--         IS NOT DISTINCT FROM
--         ROW(g.teacher_comment, g.teacher_graded_by, g.teacher_graded_at,
--             g.grade_adjust_kind, g.grade_adjust_comment, g.grade_adjusted_by, g.grade_adjusted_at,
--             g.released_comment, g.released_adjustment_comment)
--   )
--   OR (g.repo_id IS NOT NULL AND num_nonnulls(
--         g.teacher_points, g.teacher_max, g.teacher_comment, g.teacher_graded_by, g.teacher_graded_at,
--         g.grade_adjust_kind, g.grade_adjust_value, g.grade_adjust_base, g.grade_adjust_comment,
--         g.grade_adjusted_by, g.grade_adjusted_at, g.released_points, g.released_max,
--         g.released_grade, g.released_comment, g.released_adjustment_comment) = 0);
CREATE TABLE "project_repo_grades" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"teacher_points" numeric,
	"teacher_max" numeric,
	"teacher_comment" text,
	"teacher_graded_by" uuid,
	"teacher_graded_at" timestamp with time zone,
	"grade_adjust_kind" text,
	"grade_adjust_value" numeric,
	"grade_adjust_base" numeric,
	"grade_adjust_comment" text,
	"grade_adjusted_by" uuid,
	"grade_adjusted_at" timestamp with time zone,
	"released_points" numeric,
	"released_max" numeric,
	"released_grade" numeric,
	"released_comment" text,
	"released_adjustment_comment" text,
	CONSTRAINT "project_repo_grades_adjust_whole" CHECK (num_nonnulls("project_repo_grades"."grade_adjust_kind", "project_repo_grades"."grade_adjust_value", "project_repo_grades"."grade_adjust_base", "project_repo_grades"."grade_adjust_comment", "project_repo_grades"."grade_adjusted_by", "project_repo_grades"."grade_adjusted_at") IN (0, 6))
);
--> statement-breakpoint
ALTER TABLE "project_repo_grades" ADD CONSTRAINT "project_repo_grades_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repo_grades" ADD CONSTRAINT "project_repo_grades_teacher_graded_by_users_id_fk" FOREIGN KEY ("teacher_graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repo_grades" ADD CONSTRAINT "project_repo_grades_grade_adjusted_by_users_id_fk" FOREIGN KEY ("grade_adjusted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The backfill: one row per repository holding at least one value, before
-- the triggers exist (it fires neither).
INSERT INTO "project_repo_grades" (
  "repo_id", "teacher_points", "teacher_max", "teacher_comment", "teacher_graded_by", "teacher_graded_at",
  "grade_adjust_kind", "grade_adjust_value", "grade_adjust_base", "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
  "released_points", "released_max", "released_grade", "released_comment", "released_adjustment_comment"
)
SELECT
  "id", "teacher_points"::numeric, "teacher_max"::numeric, "teacher_comment", "teacher_graded_by", "teacher_graded_at",
  "grade_adjust_kind", "grade_adjust_value"::numeric, "grade_adjust_base"::numeric, "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
  "released_points"::numeric, "released_max"::numeric, "released_grade"::numeric, "released_comment", "released_adjustment_comment"
FROM "project_repos"
WHERE num_nonnulls(
  "teacher_points", "teacher_max", "teacher_comment", "teacher_graded_by", "teacher_graded_at",
  "grade_adjust_kind", "grade_adjust_value", "grade_adjust_base", "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
  "released_points", "released_max", "released_grade", "released_comment", "released_adjustment_comment"
) > 0;--> statement-breakpoint
-- New → old: what the code writes reaches the old columns, for an older
-- image after a rollback. Only what differs is written, so the 17,000 daily
-- updates of `project_repos` gain nothing from the staff's writes. At depth
-- 1 only: the write it makes fires the other trigger, which returns at once,
-- so the two never ping-pong and the exact numeric is never rounded back
-- through float8. A cascade from a deleted repository arrives deeper and
-- has no row left to clear.
CREATE FUNCTION "project_repo_grades_to_legacy"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE "project_repos" SET
      "teacher_points" = NULL, "teacher_max" = NULL, "teacher_comment" = NULL, "teacher_graded_by" = NULL, "teacher_graded_at" = NULL,
      "grade_adjust_kind" = NULL, "grade_adjust_value" = NULL, "grade_adjust_base" = NULL, "grade_adjust_comment" = NULL,
      "grade_adjusted_by" = NULL, "grade_adjusted_at" = NULL,
      "released_points" = NULL, "released_max" = NULL, "released_grade" = NULL, "released_comment" = NULL, "released_adjustment_comment" = NULL
    WHERE "id" = OLD."repo_id"
      AND num_nonnulls(
        "teacher_points", "teacher_max", "teacher_comment", "teacher_graded_by", "teacher_graded_at",
        "grade_adjust_kind", "grade_adjust_value", "grade_adjust_base", "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
        "released_points", "released_max", "released_grade", "released_comment", "released_adjustment_comment"
      ) > 0;
    RETURN NULL;
  END IF;
  UPDATE "project_repos" r SET
    "teacher_points" = NEW."teacher_points"::float8, "teacher_max" = NEW."teacher_max"::float8,
    "teacher_comment" = NEW."teacher_comment", "teacher_graded_by" = NEW."teacher_graded_by", "teacher_graded_at" = NEW."teacher_graded_at",
    "grade_adjust_kind" = NEW."grade_adjust_kind", "grade_adjust_value" = NEW."grade_adjust_value"::float8,
    "grade_adjust_base" = NEW."grade_adjust_base"::float8, "grade_adjust_comment" = NEW."grade_adjust_comment",
    "grade_adjusted_by" = NEW."grade_adjusted_by", "grade_adjusted_at" = NEW."grade_adjusted_at",
    "released_points" = NEW."released_points"::float8, "released_max" = NEW."released_max"::float8,
    "released_grade" = NEW."released_grade"::float8, "released_comment" = NEW."released_comment",
    "released_adjustment_comment" = NEW."released_adjustment_comment"
  WHERE r."id" = NEW."repo_id"
    AND ROW(
      r."teacher_points", r."teacher_max", r."teacher_comment", r."teacher_graded_by", r."teacher_graded_at",
      r."grade_adjust_kind", r."grade_adjust_value", r."grade_adjust_base", r."grade_adjust_comment", r."grade_adjusted_by", r."grade_adjusted_at",
      r."released_points", r."released_max", r."released_grade", r."released_comment", r."released_adjustment_comment"
    ) IS DISTINCT FROM ROW(
      NEW."teacher_points"::float8, NEW."teacher_max"::float8, NEW."teacher_comment", NEW."teacher_graded_by", NEW."teacher_graded_at",
      NEW."grade_adjust_kind", NEW."grade_adjust_value"::float8, NEW."grade_adjust_base"::float8, NEW."grade_adjust_comment",
      NEW."grade_adjusted_by", NEW."grade_adjusted_at",
      NEW."released_points"::float8, NEW."released_max"::float8, NEW."released_grade"::float8, NEW."released_comment",
      NEW."released_adjustment_comment"
    );
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_repo_grades_to_legacy"
AFTER INSERT OR UPDATE OR DELETE ON "project_repo_grades"
FOR EACH ROW EXECUTE FUNCTION "project_repo_grades_to_legacy"();--> statement-breakpoint
-- Old → new: what an older image writes (a rollback) reaches the new table,
-- so the roll-forward finds it. Only the columns that statement changed are
-- copied: an unchanged one keeps the new table's exact value rather than its
-- float8 copy. A repository left with no value loses its row. At depth 1
-- only, like the other.
CREATE FUNCTION "project_repo_grades_from_legacy"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF num_nonnulls(
    NEW."teacher_points", NEW."teacher_max", NEW."teacher_comment", NEW."teacher_graded_by", NEW."teacher_graded_at",
    NEW."grade_adjust_kind", NEW."grade_adjust_value", NEW."grade_adjust_base", NEW."grade_adjust_comment",
    NEW."grade_adjusted_by", NEW."grade_adjusted_at",
    NEW."released_points", NEW."released_max", NEW."released_grade", NEW."released_comment", NEW."released_adjustment_comment"
  ) = 0 THEN
    DELETE FROM "project_repo_grades" WHERE "repo_id" = NEW."id";
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      OLD."teacher_points", OLD."teacher_max", OLD."teacher_comment", OLD."teacher_graded_by", OLD."teacher_graded_at",
      OLD."grade_adjust_kind", OLD."grade_adjust_value", OLD."grade_adjust_base", OLD."grade_adjust_comment",
      OLD."grade_adjusted_by", OLD."grade_adjusted_at",
      OLD."released_points", OLD."released_max", OLD."released_grade", OLD."released_comment", OLD."released_adjustment_comment"
    ) IS NOT DISTINCT FROM ROW(
      NEW."teacher_points", NEW."teacher_max", NEW."teacher_comment", NEW."teacher_graded_by", NEW."teacher_graded_at",
      NEW."grade_adjust_kind", NEW."grade_adjust_value", NEW."grade_adjust_base", NEW."grade_adjust_comment",
      NEW."grade_adjusted_by", NEW."grade_adjusted_at",
      NEW."released_points", NEW."released_max", NEW."released_grade", NEW."released_comment", NEW."released_adjustment_comment"
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NOT EXISTS (SELECT 1 FROM "project_repo_grades" WHERE "repo_id" = NEW."id") THEN
    INSERT INTO "project_repo_grades" (
      "repo_id", "teacher_points", "teacher_max", "teacher_comment", "teacher_graded_by", "teacher_graded_at",
      "grade_adjust_kind", "grade_adjust_value", "grade_adjust_base", "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
      "released_points", "released_max", "released_grade", "released_comment", "released_adjustment_comment"
    ) VALUES (
      NEW."id", NEW."teacher_points"::numeric, NEW."teacher_max"::numeric, NEW."teacher_comment", NEW."teacher_graded_by", NEW."teacher_graded_at",
      NEW."grade_adjust_kind", NEW."grade_adjust_value"::numeric, NEW."grade_adjust_base"::numeric, NEW."grade_adjust_comment",
      NEW."grade_adjusted_by", NEW."grade_adjusted_at",
      NEW."released_points"::numeric, NEW."released_max"::numeric, NEW."released_grade"::numeric, NEW."released_comment",
      NEW."released_adjustment_comment"
    );
    RETURN NULL;
  END IF;
  UPDATE "project_repo_grades" g SET
    "teacher_points" = CASE WHEN OLD."teacher_points" IS DISTINCT FROM NEW."teacher_points" THEN NEW."teacher_points"::numeric ELSE g."teacher_points" END,
    "teacher_max" = CASE WHEN OLD."teacher_max" IS DISTINCT FROM NEW."teacher_max" THEN NEW."teacher_max"::numeric ELSE g."teacher_max" END,
    "teacher_comment" = NEW."teacher_comment",
    "teacher_graded_by" = NEW."teacher_graded_by",
    "teacher_graded_at" = NEW."teacher_graded_at",
    "grade_adjust_kind" = NEW."grade_adjust_kind",
    "grade_adjust_value" = CASE WHEN OLD."grade_adjust_value" IS DISTINCT FROM NEW."grade_adjust_value" THEN NEW."grade_adjust_value"::numeric ELSE g."grade_adjust_value" END,
    "grade_adjust_base" = CASE WHEN OLD."grade_adjust_base" IS DISTINCT FROM NEW."grade_adjust_base" THEN NEW."grade_adjust_base"::numeric ELSE g."grade_adjust_base" END,
    "grade_adjust_comment" = NEW."grade_adjust_comment",
    "grade_adjusted_by" = NEW."grade_adjusted_by",
    "grade_adjusted_at" = NEW."grade_adjusted_at",
    "released_points" = CASE WHEN OLD."released_points" IS DISTINCT FROM NEW."released_points" THEN NEW."released_points"::numeric ELSE g."released_points" END,
    "released_max" = CASE WHEN OLD."released_max" IS DISTINCT FROM NEW."released_max" THEN NEW."released_max"::numeric ELSE g."released_max" END,
    "released_grade" = CASE WHEN OLD."released_grade" IS DISTINCT FROM NEW."released_grade" THEN NEW."released_grade"::numeric ELSE g."released_grade" END,
    "released_comment" = NEW."released_comment",
    "released_adjustment_comment" = NEW."released_adjustment_comment"
  WHERE g."repo_id" = NEW."id";
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_repo_grades_from_legacy"
AFTER INSERT OR UPDATE OF
  "teacher_points", "teacher_max", "teacher_comment", "teacher_graded_by", "teacher_graded_at",
  "grade_adjust_kind", "grade_adjust_value", "grade_adjust_base", "grade_adjust_comment", "grade_adjusted_by", "grade_adjusted_at",
  "released_points", "released_max", "released_grade", "released_comment", "released_adjustment_comment"
ON "project_repos"
FOR EACH ROW EXECUTE FUNCTION "project_repo_grades_from_legacy"();
