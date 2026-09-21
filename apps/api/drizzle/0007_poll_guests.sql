ALTER TABLE "guest_participants" DROP CONSTRAINT "guest_participants_token_unique";--> statement-breakpoint
ALTER TABLE "attempts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "guest_participants" ADD COLUMN "pseudonym" text;--> statement-breakpoint
ALTER TABLE "guest_participants" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_guest_id_guest_participants_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guest_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_evaluation_guest_uq" ON "attempts" USING btree ("evaluation_id","guest_id");--> statement-breakpoint
ALTER TABLE "guest_participants" ADD CONSTRAINT "guest_participants_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_owner_ck" CHECK (("attempts"."user_id" is null) <> ("attempts"."guest_id" is null));--> statement-breakpoint
ALTER TABLE "guest_participants" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "guest_participants" DROP COLUMN "token";
