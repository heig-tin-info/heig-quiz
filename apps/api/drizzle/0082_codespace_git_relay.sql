CREATE TABLE "codespace_launches" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_launch_at" timestamp with time zone NOT NULL,
	"last_launch_at" timestamp with time zone NOT NULL,
	CONSTRAINT "codespace_launches_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "codespace_relays" (
	"github_repo_id" bigint NOT NULL,
	"sha" text NOT NULL,
	"ref" text NOT NULL,
	"user_id" uuid NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	CONSTRAINT "codespace_relays_github_repo_id_sha_pk" PRIMARY KEY("github_repo_id","sha")
);
--> statement-breakpoint
ALTER TABLE "codespace_launches" ADD CONSTRAINT "codespace_launches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codespace_launches" ADD CONSTRAINT "codespace_launches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codespace_relays" ADD CONSTRAINT "codespace_relays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;