ALTER TABLE "reverts" ALTER COLUMN "revert_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reverts" ADD COLUMN "branch" text;