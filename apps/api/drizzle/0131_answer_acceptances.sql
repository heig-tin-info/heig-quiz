CREATE TABLE "answer_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"part" text NOT NULL,
	"answer" text NOT NULL,
	"attempt_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_acceptances" ADD CONSTRAINT "answer_acceptances_item_id_evaluation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."evaluation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_acceptances" ADD CONSTRAINT "answer_acceptances_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_acceptances" ADD CONSTRAINT "answer_acceptances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_acceptances_everyone_uq" ON "answer_acceptances" USING btree ("item_id","part","answer") WHERE "answer_acceptances"."attempt_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_acceptances_attempt_uq" ON "answer_acceptances" USING btree ("item_id","part","answer","attempt_id") WHERE "answer_acceptances"."attempt_id" is not null;