import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const knowledgeDocuments = sqliteTable("knowledge_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: text("document_id").notNull().unique(),
  name: text("name").notNull(),
  department: text("department").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  rowCount: integer("row_count").notNull().default(0),
  version: text("version").notNull().default("v1.0"),
  status: text("status").notNull().default("indexing"),
  uploadedBy: text("uploaded_by").notNull().default("Knowledge Maintainer"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_knowledge_documents_department_status").on(table.department, table.status),
  index("idx_knowledge_documents_updated_at").on(table.updatedAt),
]);
