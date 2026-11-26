CREATE TABLE "codespace_distribution_reviews" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"grant_until" timestamp with time zone NOT NULL,
	CONSTRAINT "codespace_distribution_reviews_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "codespace_distribution_reviews" ADD CONSTRAINT "codespace_distribution_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codespace_distribution_reviews" ADD CONSTRAINT "codespace_distribution_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;