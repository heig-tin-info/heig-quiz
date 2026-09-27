CREATE TABLE "user_course_prefs" (
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "user_course_prefs_user_id_course_id_pk" PRIMARY KEY("user_id","course_id")
);
--> statement-breakpoint
ALTER TABLE "user_course_prefs" ADD CONSTRAINT "user_course_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_course_prefs" ADD CONSTRAINT "user_course_prefs_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;