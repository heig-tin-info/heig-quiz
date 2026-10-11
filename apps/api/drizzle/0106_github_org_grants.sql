CREATE TABLE "github_org_grants" (
	"org_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_org_grants_org_id_course_id_pk" PRIMARY KEY("org_id","course_id")
);
--> statement-breakpoint
ALTER TABLE "github_org_grants" ADD CONSTRAINT "github_org_grants_org_id_github_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."github_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_org_grants" ADD CONSTRAINT "github_org_grants_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_org_grants" ADD CONSTRAINT "github_org_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_org_grants_course_idx" ON "github_org_grants" USING btree ("course_id");--> statement-breakpoint
-- ADR-100 §7: every course gets the organizations its classrooms are already
-- connected to, so nothing breaks at deploy; granted by whoever made the
-- earliest of those links, at that moment. This also legitimizes a link made
-- before the grants existed: the `github_org.link` audit entries are
-- reviewed before production.
INSERT INTO "github_org_grants" ("org_id", "course_id", "granted_by", "granted_at")
SELECT DISTINCT ON (l."org_id", c."course_id") l."org_id", c."course_id", l."linked_by", l."linked_at"
FROM "github_classroom_links" l
JOIN "classrooms" c ON c."id" = l."classroom_id"
ORDER BY l."org_id", c."course_id", l."linked_at"
ON CONFLICT DO NOTHING;