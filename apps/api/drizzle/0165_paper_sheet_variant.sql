-- ADR-148: the paper variant a paper copy was typed from; every copy entered before variants was variant 1.
ALTER TABLE "paper_sheets" ADD COLUMN "variant" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_sheets" ADD CONSTRAINT "paper_sheets_variant_ck" CHECK ("paper_sheets"."variant" >= 1);