CREATE TABLE `admitted_images` (
	`reference` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`detail` text,
	`base_version` text,
	`compressed_bytes` integer,
	`disk_bytes` integer,
	`source` text NOT NULL,
	`requested_at` integer NOT NULL,
	`admitted_at` integer,
	`last_used_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admitted_images_digest_idx` ON `admitted_images` (`digest`);--> statement-breakpoint
ALTER TABLE `assignments` ADD `image_ref` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `image` text;