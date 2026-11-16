CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`student` text NOT NULL,
	`assignment` text NOT NULL,
	`ref` text NOT NULL,
	`base` text NOT NULL,
	`outcome` text NOT NULL,
	`tree` text,
	`commit` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `collections_pair_idx` ON `collections` (`student`,`assignment`,`at`);