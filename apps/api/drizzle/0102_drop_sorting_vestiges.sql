-- Safety net: migration 0098 already deleted every row that is not a complete `drop`; the columns below only hold for those.
DELETE FROM "concept_tag_sortings" WHERE "decision" IS DISTINCT FROM 'drop' OR "drop_reason" IS NULL OR "decided_at" IS NULL;--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP CONSTRAINT "concept_tag_sortings_decided_ck";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP CONSTRAINT "concept_tag_sortings_decision_ck";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP CONSTRAINT "concept_tag_sortings_concept_id_concepts_id_fk";
--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP CONSTRAINT "concept_tag_sortings_decided_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "concept_tag_sortings_concept_idx";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ALTER COLUMN "drop_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ALTER COLUMN "decided_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" ALTER COLUMN "decided_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP COLUMN "decision";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP COLUMN "concept_id";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP COLUMN "proposal";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP COLUMN "decided_by";--> statement-breakpoint
ALTER TABLE "concept_tag_sortings" DROP COLUMN "updated_at";