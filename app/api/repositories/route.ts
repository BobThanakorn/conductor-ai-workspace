import { z } from "zod";

import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  validationError,
} from "@/lib/api-contract";
import {
  ensureEnvironmentDatabase,
  getDatabase,
  listRepositories,
  registerRepository,
} from "@/lib/environment-store";

export const dynamic = "force-dynamic";

const repositoryRegistrationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    path: z.string().trim().min(1).max(1_000),
    provider: z.enum(["local", "github"]).default("local"),
    defaultBranch: z.string().trim().max(180).default("main"),
    activeBranch: z.string().trim().max(180).default("main"),
    baseSha: z.string().trim().max(128).default(""),
    headSha: z.string().trim().max(128).default(""),
  })
  .strict();

export async function GET() {
  try {
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    return jsonResponse({
      ok: true,
      repositories: await listRepositories(database),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const parsed = repositoryRegistrationSchema.safeParse(
      await readJsonBody(request),
    );
    if (!parsed.success) throw validationError(parsed.error);
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const repository = await registerRepository(database, parsed.data);
    return jsonResponse({ ok: true, repository }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
