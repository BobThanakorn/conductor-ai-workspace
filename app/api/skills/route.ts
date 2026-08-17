import { errorResponse, jsonResponse } from "@/lib/api-contract";
import { fetchSkillCatalog } from "@/lib/skill-loader";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const catalog = await fetchSkillCatalog();
    return jsonResponse({ ok: true, catalog });
  } catch (error) {
    return errorResponse(error);
  }
}
