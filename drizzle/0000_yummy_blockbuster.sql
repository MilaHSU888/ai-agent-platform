CREATE TABLE `knowledge_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`name` text NOT NULL,
	`department` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`version` text DEFAULT 'v1.0' NOT NULL,
	`status` text DEFAULT 'indexing' NOT NULL,
	`uploaded_by` text DEFAULT 'Knowledge Maintainer' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_documents_document_id_unique` ON `knowledge_documents` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_documents_department_status` ON `knowledge_documents` (`department`,`status`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_documents_updated_at` ON `knowledge_documents` (`updated_at`);