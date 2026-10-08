CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"merged_into" uuid,
	"created_by" uuid,
	"label_fr" text,
	"label_en" text,
	"qualifier_fr" text DEFAULT '' NOT NULL,
	"qualifier_en" text DEFAULT '' NOT NULL,
	"description_fr" text DEFAULT '' NOT NULL,
	"description_en" text DEFAULT '' NOT NULL,
	"key_fr" text,
	"key_en" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_merged_ck" CHECK (("concepts"."status" = 'merged') = ("concepts"."merged_into" is not null) and "concepts"."merged_into" is distinct from "concepts"."id"),
	CONSTRAINT "concepts_label_ck" CHECK ("concepts"."label_fr" is not null or "concepts"."label_en" is not null)
);
--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_merged_into_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."concepts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_key_fr_uq" ON "concepts" USING btree ("key_fr") WHERE "concepts"."status" <> 'merged' and "concepts"."key_fr" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_key_en_uq" ON "concepts" USING btree ("key_en") WHERE "concepts"."status" <> 'merged' and "concepts"."key_en" is not null;