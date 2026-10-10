CREATE TABLE "pool_subscriptions" (
	"pool_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_subscriptions_pool_id_user_id_pk" PRIMARY KEY("pool_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "course_pools" ADD COLUMN "mode" text DEFAULT 'edit' NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_subscriptions" ADD CONSTRAINT "pool_subscriptions_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_subscriptions" ADD CONSTRAINT "pool_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_subscriptions_user_idx" ON "pool_subscriptions" USING btree ("user_id");