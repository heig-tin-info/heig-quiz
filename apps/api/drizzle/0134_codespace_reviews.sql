CREATE TABLE "codespace_reviews" (
	"user_id" uuid NOT NULL,
	"project_repo_id" uuid NOT NULL,
	"grant_until" timestamp with time zone NOT NULL,
	CONSTRAINT "codespace_reviews_user_id_project_repo_id_pk" PRIMARY KEY("user_id","project_repo_id")
);
--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD CONSTRAINT "codespace_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codespace_reviews" ADD CONSTRAINT "codespace_reviews_project_repo_id_project_repos_id_fk" FOREIGN KEY ("project_repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;