CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"pool_id" uuid,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pool_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_pools" (
	"course_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_pools_course_id_pool_id_pk" PRIMARY KEY("course_id","pool_id")
);
--> statement-breakpoint
CREATE TABLE "pool_members" (
	"pool_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_members_pool_id_user_id_pk" PRIMARY KEY("pool_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owner_id" uuid NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_tags" (
	"question_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "question_tags_question_id_tag_pk" PRIMARY KEY("question_id","tag")
);
--> statement-breakpoint
CREATE TABLE "question_version_assets" (
	"version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "question_version_assets_version_id_asset_id_pk" PRIMARY KEY("version_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL,
	"number" integer,
	"config" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"change_note" text,
	"deprecated_at" timestamp with time zone,
	"deprecation_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pool_id" uuid NOT NULL,
	"category_id" uuid,
	"type" text NOT NULL,
	"internal_name" text NOT NULL,
	"difficulty" smallint DEFAULT 2 NOT NULL,
	"shuffleable" boolean DEFAULT true NOT NULL,
	"randomizable" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"origin_question_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_difficulty_check" CHECK ("questions"."difficulty" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "classrooms" ADD COLUMN "join_code_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_pools" ADD CONSTRAINT "course_pools_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_pools" ADD CONSTRAINT "course_pools_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_tags" ADD CONSTRAINT "question_tags_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_version_assets" ADD CONSTRAINT "question_version_assets_version_id_question_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."question_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_version_assets" ADD CONSTRAINT "question_version_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_origin_fk" FOREIGN KEY ("origin_question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "assets_pool_idx" ON "assets" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "categories_pool_idx" ON "categories" USING btree ("pool_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "course_pools_pool_idx" ON "course_pools" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "pool_members_user_idx" ON "pool_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pools_owner_idx" ON "pools" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_personal_uq" ON "pools" USING btree ("owner_id") WHERE "pools"."is_personal";--> statement-breakpoint
CREATE INDEX "question_tags_tag_idx" ON "question_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "question_version_assets_asset_idx" ON "question_version_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_question_number_uq" ON "question_versions" USING btree ("question_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "question_versions_draft_uq" ON "question_versions" USING btree ("question_id") WHERE "question_versions"."number" is null;--> statement-breakpoint
CREATE INDEX "question_versions_question_idx" ON "question_versions" USING btree ("question_id","number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "question_versions_search_idx" ON "question_versions" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_pool_name_uq" ON "questions" USING btree ("pool_id",lower("internal_name")) WHERE "questions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "questions_pool_type_idx" ON "questions" USING btree ("pool_id","type");--> statement-breakpoint
CREATE INDEX "questions_category_idx" ON "questions" USING btree ("category_id");