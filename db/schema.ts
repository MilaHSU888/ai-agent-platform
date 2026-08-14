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

export const knowledgeAccounts = sqliteTable("knowledge_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userKey: text("user_key").notNull().unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  jobTitle: text("job_title").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const departmentPermissions = sqliteTable("department_permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().references(() => knowledgeAccounts.id, { onDelete: "cascade" }),
  department: text("department").notNull(),
  role: text("role").notNull().default("viewer"),
  grantedBy: text("granted_by").notNull(),
  grantedAt: text("granted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_department_permissions_account_department").on(table.accountId, table.department),
  index("idx_department_permissions_department_role").on(table.department, table.role),
]);
