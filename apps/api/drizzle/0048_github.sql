CREATE TABLE "github_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_accounts_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "github_classroom_links" (
	"classroom_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"github_org_id" bigint,
	"login" text NOT NULL,
	"installation_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text,
	CONSTRAINT "github_organizations_github_org_id_unique" UNIQUE("github_org_id"),
	CONSTRAINT "github_organizations_login_unique" UNIQUE("login"),
	CONSTRAINT "github_organizations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "push_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"forced" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"payload" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_classroom_links" ADD CONSTRAINT "github_classroom_links_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_classroom_links" ADD CONSTRAINT "github_classroom_links_org_id_github_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."github_organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_classroom_links" ADD CONSTRAINT "github_classroom_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_classroom_links_org_idx" ON "github_classroom_links" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_receipts_repo_sha_uq" ON "push_receipts" USING btree ("github_repo_id","head_sha");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("received_at") WHERE "webhook_deliveries"."processed_at" IS NULL;