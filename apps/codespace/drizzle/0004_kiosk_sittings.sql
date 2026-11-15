CREATE TABLE `closed_sittings` (
	`sitting` text PRIMARY KEY NOT NULL,
	`closed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `closed_sittings_closed_at_idx` ON `closed_sittings` (`closed_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `opened_by_sitting` text;