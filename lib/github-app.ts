import { ApiError } from "./api-contract.ts";

const GITHUB_API = "https://api.github.com";
const MAX_INSTALLATION_ID = 9_007_199_254_740_991;
const PERMIT_TTL_SECONDS = 300;

export type GitHubAppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  publicationSigningSecret: string;
};

export type GitHubRepository = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
};

export type PublicationRequest = {
  workspaceId: string;
  installationId: number;
  repository: string;
  sourceRef: string;
  headSha: string;
  targetBranch: string;
  pullNumber: number;
};

export type PublicationPermit = PublicationRequest & {
  version: 1;
  actorId: string;
  policyDigest: string;
  permitId: string;
  issuedAt: number;
  expiresAt: number;
};

export type PublicationPolicy = {
  requiredChecks: Array<{ context: string; appId?: number }>;
  requiredApprovals: number;
  dismissStaleReviews: boolean;
  enforceAdmins: boolean;
  targetProtected: boolean;
};

export type ValidatedPublication = {
  repository: GitHubRepository;
  policy: PublicationPolicy;
  policyDigest: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubResponse = Record<string, unknown>;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asBufferSource(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson<T>(value: string): T {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return JSON.parse(new TextDecoder().decode(decodeBase64(padded))) as T;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const size = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < size; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestGitHubWebhookBody(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", asBufferSource(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function requireInstallationId(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > MAX_INSTALLATION_ID) {
    throw new ApiError(400, "github_installation_invalid", "A valid GitHub App installation ID is required.");
  }
  return value;
}

function requireRepository(value: string): { owner: string; name: string; fullName: string } {
  const [owner, name, extra] = value.split("/");
  if (!owner || !name || extra || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new ApiError(400, "github_repository_invalid", "repository must be a GitHub owner/name value.");
  }
  return { owner, name, fullName: `${owner}/${name}` };
}

function requireRef(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) || trimmed.includes("..") || trimmed.endsWith("/")) {
    throw new ApiError(400, "github_ref_invalid", `${field} is not a safe Git ref.`);
  }
  return trimmed;
}

function requireSha(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(trimmed)) throw new ApiError(400, "github_sha_invalid", "headSha must be a full commit SHA.");
  return trimmed;
}

function readPrivateKey(pem: string): Uint8Array {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.trim());
  if (!match) throw new ApiError(503, "github_app_private_key_invalid", "GitHub App private key must be PKCS#8 PEM.");
  try { return decodeBase64(match[1]); } catch { throw new ApiError(503, "github_app_private_key_invalid", "GitHub App private key is malformed."); }
}

export function githubAppConfigFromEnvironment(source: Record<string, string | undefined>): GitHubAppConfig {
  const appId = source.GITHUB_APP_ID?.trim() ?? "";
  const privateKey = source.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim() ?? "";
  const webhookSecret = source.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
  const publicationSigningSecret = source.CONDUCTOR_PUBLICATION_SIGNING_SECRET?.trim() ?? "";
  if (!/^[1-9][0-9]{0,17}$/.test(appId) || !privateKey || !webhookSecret || !publicationSigningSecret) {
    throw new ApiError(503, "github_app_not_configured", "GitHub App server configuration is incomplete.");
  }
  readPrivateKey(privateKey);
  return { appId, privateKey, webhookSecret, publicationSigningSecret };
}

export async function createGitHubAppJwt(config: Pick<GitHubAppConfig, "appId" | "privateKey">, now = Date.now()): Promise<string> {
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const issuedAt = Math.floor(now / 1000) - 30;
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 8 * 60, iss: config.appId });
  const key = await crypto.subtle.importKey("pkcs8", asBufferSource(readPrivateKey(config.privateKey)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Conductor-GitHub-App",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function responseBody(response: Response): Promise<GitHubResponse> {
  try { return await response.json() as GitHubResponse; } catch { return {}; }
}

function githubFailure(status: number): ApiError {
  if (status === 401 || status === 403 || status === 404) return new ApiError(403, "github_provider_access_denied", "GitHub App access was denied for this installation or repository.");
  return new ApiError(502, "github_provider_unavailable", "GitHub could not verify the required publication policy.");
}

function repositoryFrom(value: GitHubResponse): GitHubRepository {
  const owner = value.owner as GitHubResponse | undefined;
  if (typeof value.id !== "number" || typeof value.full_name !== "string" || typeof owner?.login !== "string" || typeof value.name !== "string" || typeof value.default_branch !== "string" || typeof value.private !== "boolean") {
    throw new ApiError(502, "github_provider_invalid_response", "GitHub returned an invalid repository response.");
  }
  return { id: value.id, fullName: value.full_name, owner: owner.login, name: value.name, defaultBranch: value.default_branch, private: value.private };
}

function newestProviderValue(values: GitHubResponse[]): GitHubResponse | undefined {
  // GitHub returns these collections newest first, but timestamps and IDs make
  // the selection deterministic when a provider or test double does not.
  return values.reduce<GitHubResponse | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const latestMoment = String(latest.completed_at ?? latest.updated_at ?? latest.created_at ?? "");
    const candidateMoment = String(candidate.completed_at ?? candidate.updated_at ?? candidate.created_at ?? "");
    if (candidateMoment > latestMoment) return candidate;
    if (candidateMoment < latestMoment) return latest;
    return Number(candidate.id ?? 0) > Number(latest.id ?? 0) ? candidate : latest;
  }, undefined);
}

export class GitHubAppClient {
  private readonly config: GitHubAppConfig;
  private readonly fetcher: FetchLike;

  constructor(config: GitHubAppConfig, fetcher: FetchLike = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async requestInstallationToken(installationId: number): Promise<string> {
    const jwt = await createGitHubAppJwt(this.config);
    const response = await this.fetcher(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubHeaders(jwt),
    });
    const result = await responseBody(response);
    if (!response.ok || typeof result.token !== "string" || !result.token) throw githubFailure(response.status);
    return result.token;
  }

  private async request(token: string, pathname: string): Promise<GitHubResponse> {
    const response = await this.fetcher(`${GITHUB_API}${pathname}`, { headers: githubHeaders(token) });
    const result = await responseBody(response);
    if (!response.ok) throw githubFailure(response.status);
    return result;
  }

  private async listAllPages(
    token: string,
    pathname: string,
    collection: string,
  ): Promise<GitHubResponse[]> {
    const output: GitHubResponse[] = [];
    const separator = pathname.includes("?") ? "&" : "?";
    // GitHub endpoints cap pages at 100. Never infer completeness from the
    // first response: a stale failure or approval beyond page one must deny.
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request(token, `${pathname}${separator}per_page=100&page=${page}`);
      const values = collection === "root" ? result : result[collection];
      if (!Array.isArray(values)) {
        throw new ApiError(502, "github_provider_invalid_response", "GitHub returned an invalid paginated response.");
      }
      output.push(...values.map((value) => value as GitHubResponse));
      if (values.length < 100) return output;
    }
    throw new ApiError(502, "github_provider_pagination_limit", "GitHub pagination exceeded the safe page limit.");
  }

  private async requestMutation(token: string, pathname: string, body: Record<string, unknown>): Promise<GitHubResponse> {
    const response = await this.fetcher(`${GITHUB_API}${pathname}`, {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await responseBody(response);
    if (!response.ok) {
      throw new ApiError(409, "github_merge_rejected", "GitHub rejected the protected pull-request merge.");
    }
    return result;
  }

  private async listAllInstallationRepositories(token: string): Promise<GitHubRepository[]> {
    const output: GitHubRepository[] = [];
    // GitHub caps a page at 100; use a fixed maximum to bound provider work.
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request(token, `/installation/repositories?per_page=100&page=${page}`);
      if (!Array.isArray(result.repositories)) throw new ApiError(502, "github_provider_invalid_response", "GitHub did not return installation repositories.");
      output.push(...result.repositories.map((item) => repositoryFrom(item as GitHubResponse)));
      if (result.repositories.length < 100) return output;
    }
    throw new ApiError(502, "github_repository_list_too_large", "GitHub App repository listing exceeded the safe pagination limit.");
  }

  async listInstallationRepositories(installationIdInput: unknown): Promise<GitHubRepository[]> {
    const installationId = requireInstallationId(installationIdInput);
    const token = await this.requestInstallationToken(installationId);
    return this.listAllInstallationRepositories(token);
  }

  async repositoryForInstallation(installationIdInput: unknown, repositoryInput: string): Promise<GitHubRepository> {
    const installationId = requireInstallationId(installationIdInput);
    const expected = requireRepository(repositoryInput);
    const token = await this.requestInstallationToken(installationId);
    // A direct repository request made with an installation token is the
    // authoritative membership check and works even when an installation has
    // more than one page of repositories.
    return repositoryFrom(await this.request(token, `/repos/${expected.owner}/${expected.name}`));
  }

  async validatePublication(input: PublicationRequest): Promise<ValidatedPublication> {
    const installationId = requireInstallationId(input.installationId);
    const repository = requireRepository(input.repository);
    const sourceRef = requireRef(input.sourceRef, "sourceRef");
    const targetBranch = requireRef(input.targetBranch, "targetBranch");
    const headSha = requireSha(input.headSha);
    if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) throw new ApiError(400, "github_pull_invalid", "pullNumber must be a positive integer.");
    const token = await this.requestInstallationToken(installationId);
    const freshRepository = repositoryFrom(await this.request(token, `/repos/${repository.owner}/${repository.name}`));
    if (sourceRef === freshRepository.defaultBranch || sourceRef === targetBranch) {
      throw new ApiError(403, "github_direct_protected_branch_forbidden", "A publication permit must use a separate source branch and can never represent a direct default or protected branch push.");
    }
    // targetBranch is the pull-request base. It is deliberately required to
    // be protected: publication is represented only as a reviewed PR, never
    // as a push to that branch.
    const targetProtectionResponse = await this.fetcher(`${GITHUB_API}/repos/${repository.owner}/${repository.name}/branches/${encodeURIComponent(targetBranch)}/protection`, { headers: githubHeaders(token) });
    const protection = await responseBody(targetProtectionResponse);
    if (!targetProtectionResponse.ok) throw new ApiError(403, "github_target_branch_protection_required", "The pull-request target branch must have fresh branch-protection policy before publication.");
    const branch = await this.request(token, `/repos/${repository.owner}/${repository.name}/branches/${encodeURIComponent(sourceRef)}`);
    const branchCommit = branch.commit as GitHubResponse | undefined;
    if (typeof branchCommit?.sha !== "string" || branchCommit.sha.toLowerCase() !== headSha) throw new ApiError(409, "github_head_changed", "The source branch head no longer matches the reviewed commit.");
    const pull = await this.request(token, `/repos/${repository.owner}/${repository.name}/pulls/${input.pullNumber}`);
    const pullHead = pull.head as GitHubResponse | undefined;
    const pullBase = pull.base as GitHubResponse | undefined;
    const pullHeadRepo = pullHead?.repo as GitHubResponse | undefined;
    if (pull.state !== "open" || pull.draft === true || pullHead?.ref !== sourceRef || pullHead?.sha !== headSha || pullBase?.ref !== targetBranch || pullHeadRepo?.full_name !== freshRepository.fullName) {
      throw new ApiError(409, "github_pull_not_publishable", "The pull request no longer matches the reviewed repository, branch, and commit.");
    }
    const statusPolicy = protection.required_status_checks as GitHubResponse | undefined;
    const detailedChecks: PublicationPolicy["requiredChecks"] = Array.isArray(statusPolicy?.checks)
      ? statusPolicy.checks.flatMap((value) => {
        const check = value as GitHubResponse;
        return typeof check.context === "string" && (!("app_id" in check) || typeof check.app_id === "number")
          ? [{ context: check.context, ...(typeof check.app_id === "number" ? { appId: check.app_id } : {}) }]
          : [];
      })
      : [];
    const fallbackChecks: PublicationPolicy["requiredChecks"] = Array.isArray(statusPolicy?.contexts)
      ? statusPolicy.contexts.filter((value): value is string => typeof value === "string").map((context) => ({ context }))
      : [];
    const requiredChecks: PublicationPolicy["requiredChecks"] = (detailedChecks.length ? detailedChecks : fallbackChecks)
      .sort((left, right) => left.context.localeCompare(right.context) || (left.appId ?? -1) - (right.appId ?? -1));
    const checkRuns = await this.listAllPages(token, `/repos/${repository.owner}/${repository.name}/commits/${headSha}/check-runs`, "check_runs");
    const completedChecks = new Map<string, GitHubResponse[]>();
    for (const check of checkRuns) {
      const value = check as GitHubResponse;
      if (typeof value.name === "string") completedChecks.set(value.name, [...(completedChecks.get(value.name) ?? []), value]);
    }
    const statuses = await this.listAllPages(token, `/repos/${repository.owner}/${repository.name}/commits/${headSha}/status`, "statuses");
    const completedStatuses = new Map<string, GitHubResponse[]>();
    for (const status of statuses) {
      const value = status as GitHubResponse;
      if (typeof value.context === "string") completedStatuses.set(value.context, [...(completedStatuses.get(value.context) ?? []), value]);
    }
    for (const required of requiredChecks) {
      const currentRun = newestProviderValue((completedChecks.get(required.context) ?? []).filter((check) => {
        const app = check.app as GitHubResponse | undefined;
        return required.appId === undefined || app?.id === required.appId;
      }));
      const currentStatus = required.appId === undefined ? newestProviderValue(completedStatuses.get(required.context) ?? []) : undefined;
      const matchingRun = currentRun?.status === "completed" && currentRun.conclusion === "success";
      const matchingStatus = currentStatus?.state === "success";
      if (!matchingRun && !matchingStatus) throw new ApiError(409, "github_required_checks_incomplete", "Required GitHub checks are not passing on the reviewed commit.");
    }
    const reviewPolicy = protection.required_pull_request_reviews as GitHubResponse | undefined;
    const requiredApprovals = typeof reviewPolicy?.required_approving_review_count === "number" ? reviewPolicy.required_approving_review_count : 0;
    const reviews = await this.listAllPages(token, `/repos/${repository.owner}/${repository.name}/pulls/${input.pullNumber}/reviews`, "root");
    const latestReviewByUser = new Map<string, GitHubResponse>();
    for (const review of reviews) {
      const value = review as GitHubResponse;
      const user = value.user as GitHubResponse | undefined;
      if (typeof user?.login !== "string" || typeof value.submitted_at !== "string") continue;
      const key = user.login.toLowerCase();
      const previous = latestReviewByUser.get(key);
      if (!previous || String(previous.submitted_at) <= value.submitted_at) latestReviewByUser.set(key, value);
    }
    const approvedBy = [...latestReviewByUser.values()].filter((review) => review.state === "APPROVED" && (!reviewPolicy?.dismiss_stale_reviews || review.commit_id === headSha));
    if (approvedBy.length < requiredApprovals) throw new ApiError(409, "github_required_reviews_incomplete", "Required GitHub pull-request approvals are not present.");
    const policy: PublicationPolicy = {
      requiredChecks,
      requiredApprovals,
      dismissStaleReviews: reviewPolicy?.dismiss_stale_reviews === true,
      enforceAdmins: (protection.enforce_admins as GitHubResponse | undefined)?.enabled === true,
      targetProtected: true,
    };
    return { repository: freshRepository, policy, policyDigest: await sha256(canonical(policy)) };
  }

  /**
   * The only GitHub mutation in this module. It rechecks the protected branch,
   * PR head, effective checks and reviews in this request immediately before
   * calling GitHub's merge endpoint. The installation token stays in this call
   * stack and is neither returned, logged, nor stored.
   */
  async mergeProtectedPullRequest(input: PublicationRequest, expectedPolicyDigest: string): Promise<{
    repository: string;
    mergeSha: string;
    policyDigest: string;
    reconciled: boolean;
  }> {
    let validation: ValidatedPublication;
    try {
      validation = await this.validatePublication(input);
    } catch (error) {
      // A process can fail after GitHub accepted the merge but before durable
      // completion. A stale idempotency lease may retry only by reconciling the
      // provider's immutable merged-PR state; it never retries a direct push.
      if (error instanceof ApiError && error.code === "github_pull_not_publishable") {
        const repository = requireRepository(input.repository);
        const token = await this.requestInstallationToken(requireInstallationId(input.installationId));
        const pull = await this.request(token, `/repos/${repository.owner}/${repository.name}/pulls/${input.pullNumber}`);
        const head = pull.head as GitHubResponse | undefined;
        const base = pull.base as GitHubResponse | undefined;
        if (pull.state === "closed" && pull.merged === true && head?.ref === requireRef(input.sourceRef, "sourceRef") && head?.sha === requireSha(input.headSha) && base?.ref === requireRef(input.targetBranch, "targetBranch") && typeof pull.merge_commit_sha === "string" && /^[0-9a-f]{40,64}$/i.test(pull.merge_commit_sha)) {
          return { repository: `${repository.owner}/${repository.name}`, mergeSha: pull.merge_commit_sha.toLowerCase(), policyDigest: expectedPolicyDigest, reconciled: true };
        }
      }
      throw error;
    }
    if (validation.policyDigest !== expectedPolicyDigest) {
      throw new ApiError(409, "publication_policy_changed", "GitHub branch, check, or review policy changed after the permit was issued.");
    }
    const repository = requireRepository(input.repository);
    const installationId = requireInstallationId(input.installationId);
    const headSha = requireSha(input.headSha);
    const token = await this.requestInstallationToken(installationId);
    const result = await this.requestMutation(token, `/repos/${repository.owner}/${repository.name}/pulls/${input.pullNumber}/merge`, {
      sha: headSha,
      merge_method: "squash",
    });
    if (result.merged !== true || typeof result.sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(result.sha)) {
      throw new ApiError(409, "github_merge_rejected", "GitHub did not confirm the protected pull-request merge.");
    }
    return { repository: validation.repository.fullName, mergeSha: result.sha.toLowerCase(), policyDigest: validation.policyDigest, reconciled: false };
  }
}

export async function issuePublicationPermit(input: Omit<PublicationPermit, "version" | "permitId" | "issuedAt" | "expiresAt">, signingSecret: string, now = Date.now()): Promise<string> {
  if (!signingSecret.trim()) throw new ApiError(503, "publication_permit_not_configured", "Publication permit signing is not configured.");
  const payload: PublicationPermit = { ...input, version: 1, permitId: crypto.randomUUID(), issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + PERMIT_TTL_SECONDS };
  const encoded = encodeJson(payload);
  return `v1.${encoded}.${await hmac(encoded, signingSecret)}`;
}

export async function verifyPublicationPermit(token: string, expected: Pick<PublicationPermit, "actorId" | "workspaceId" | "installationId" | "repository" | "sourceRef" | "headSha" | "targetBranch" | "pullNumber">, signingSecret: string, now = Date.now()): Promise<PublicationPermit> {
  const [version, encoded, signature, extra] = token.split(".");
  if (version !== "v1" || !encoded || !signature || extra || !signingSecret.trim() || !constantTimeEqual(await hmac(encoded, signingSecret), signature)) {
    throw new ApiError(403, "publication_permit_invalid", "The publication permit is invalid.");
  }
  let payload: PublicationPermit;
  try { payload = decodeJson<PublicationPermit>(encoded); } catch { throw new ApiError(403, "publication_permit_invalid", "The publication permit is invalid."); }
  if (payload.version !== 1 || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Math.floor(now / 1000) || payload.actorId !== expected.actorId || payload.workspaceId !== expected.workspaceId || payload.installationId !== expected.installationId || payload.repository !== expected.repository || payload.sourceRef !== expected.sourceRef || payload.headSha !== expected.headSha || payload.targetBranch !== expected.targetBranch || payload.pullNumber !== expected.pullNumber) {
    throw new ApiError(403, "publication_permit_scope_forbidden", "The publication permit is expired or does not match the verified publication scope.");
  }
  return payload;
}

export async function verifyGitHubWebhook(rawBody: Uint8Array, signatureHeader: string | null, secret: string): Promise<void> {
  if (!secret.trim() || !signatureHeader?.startsWith("sha256=")) throw new ApiError(401, "github_webhook_signature_invalid", "GitHub webhook signature verification failed.");
  const received = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) throw new ApiError(401, "github_webhook_signature_invalid", "GitHub webhook signature verification failed.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, asBufferSource(rawBody)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!constantTimeEqual(expected, received)) throw new ApiError(401, "github_webhook_signature_invalid", "GitHub webhook signature verification failed.");
}
