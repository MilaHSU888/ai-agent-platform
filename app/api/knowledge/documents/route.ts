import { desc } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../../db";
import { knowledgeDocuments } from "../../../../db/schema";

const demoWriteDepartments: Record<string, string[]> = {
  mila: ["finance", "hr", "purchase", "quality", "rd", "manufacturing", "sales", "it"],
  "finance-owner": ["finance"],
  "quality-reviewer": ["quality"],
  "rd-editor": ["rd"],
};

function canDemoAccountUpload(request: Request, department: string) {
  const demoUserId = request.headers.get("x-demo-user-id");
  return Boolean(demoUserId && demoWriteDepartments[demoUserId]?.includes(department));
}

export async function GET() {
  try {
    const db = getDb();
    const documents = await db.select().from(knowledgeDocuments).orderBy(desc(knowledgeDocuments.updatedAt)).limit(100);
    return Response.json({ documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法讀取知識文件";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const department = String(form.get("department") ?? "").trim();
    const rowCount = Number(form.get("rowCount") ?? 0);
    if (!(file instanceof File) || !department) {
      return Response.json({ error: "file and department are required" }, { status: 400 });
    }
    if (!canDemoAccountUpload(request, department)) {
      return Response.json({ error: "此帳號沒有該部門知識庫的上傳權限" }, { status: 403 });
    }
    if (file.size > 25 * 1024 * 1024) {
      return Response.json({ error: "檔案不可超過 25 MB" }, { status: 413 });
    }

    const runtimeEnv = env as unknown as { KNOWLEDGE_FILES?: R2Bucket };
    if (!runtimeEnv.KNOWLEDGE_FILES) {
      throw new Error("KNOWLEDGE_FILES binding is unavailable");
    }

    const nonce = crypto.randomUUID();
    const objectKey = `${department}/${new Date().toISOString().slice(0, 10)}/${nonce}-${file.name}`;
    await runtimeEnv.KNOWLEDGE_FILES.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { department, originalName: file.name },
    });

    const documentId = `KB-${Date.now().toString().slice(-8)}`;
    const db = getDb();
    const [document] = await db.insert(knowledgeDocuments).values({
      documentId,
      name: file.name,
      department,
      objectKey,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      rowCount: Number.isFinite(rowCount) ? rowCount : 0,
      status: "indexing",
    }).returning();

    return Response.json({ document }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法上傳知識文件";
    return Response.json({ error: message }, { status: 500 });
  }
}
