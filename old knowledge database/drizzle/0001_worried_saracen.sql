CREATE TABLE `department_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`department` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `knowledge_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_department_permissions_account_department` ON `department_permissions` (`account_id`,`department`);--> statement-breakpoint
CREATE INDEX `idx_department_permissions_department_role` ON `department_permissions` (`department`,`role`);--> statement-breakpoint
CREATE TABLE `knowledge_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`job_title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_accounts_user_key_unique` ON `knowledge_accounts` (`user_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_accounts_email_unique` ON `knowledge_accounts` (`email`);