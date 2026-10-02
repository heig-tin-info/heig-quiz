CREATE TABLE "question_reviews" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"ignored_by" uuid,
	"ignored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_pools" (
	"pool_id" uuid PRIMARY KEY NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_version_id_question_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."question_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reviews" ADD CONSTRAINT "question_reviews_ignored_by_users_id_fk" FOREIGN KEY ("ignored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_pools" ADD CONSTRAINT "review_pools_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_pools" ADD CONSTRAINT "review_pools_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;