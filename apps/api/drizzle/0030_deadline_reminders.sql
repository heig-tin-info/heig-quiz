CREATE TABLE "deadline_reminders" (
	"evaluation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deadline_reminders_evaluation_id_user_id_pk" PRIMARY KEY("evaluation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "deadline_reminders" ADD CONSTRAINT "deadline_reminders_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_reminders" ADD CONSTRAINT "deadline_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;