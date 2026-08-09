import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GitHubAppClient,
  createGitHubAppJwt,
  digestGitHubWebhookBody,
  githubAppConfigFromEnvironment,
  issuePublicationPermit,
  verifyGitHubWebhook,
  verifyPublicationPermit,
} from "../lib/github-app.ts";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = githubAppConfigFromEnvironment({
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  CONDUCTOR_PUBLICATION_SIGNING_SECRET: "publication-secret",
});

function repository() {
  return { id: 7, full_name: "octo/secure-repo", name: "secure-repo", default_branch: "main", private: true, owner: { login: "octo" } };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("GitHub App JWT uses a short-lived RS256 signature without exposing the key", async () => {
  const jwt = await createGitHubAppJwt(config, 1_700_000_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg, "RS256");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), { iat: 1_699_999_970, exp: 1_700_000_450, iss: "12345" });
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keyPair.publicKey, Buffer.from(signature, "base64url")), true);
  assert.throws(() => githubAppConfigFromEnvironment({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not a key", GITHUB_WEBHOOK_SECRET: "x", CONDUCTOR_PUBLICATION_SIGNING_SECRET: "y" }));
});

test("repository selection is constrained to the verified GitHub App installation", async () => {
  const calls: string[] = [];
  const client = new GitHubAppClient(config, async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (String(url).includes("/installation/repositories")) return response({ repositories: [repository()] });
    if (String(url).endsWith("/repos/octo/secure-repo")) return response(repository());
    return response({}, 404);
  });
  const selected = await client.repositoryForInstallation(99, "octo/secure-repo");
  assert.equal(selected.fullName, "octo/secure-repo");
  await assert.rejects(() => client.repositoryForInstallation(99, "octo/not-installed"), /access was denied/i);
  assert.equal(calls.some((url) => url.endsWith("/repos/octo/not-installed")), true);
});

test("repository listing route requires a signed server principal and never accepts a body actor", async () => {
  const source = await readFile(new URL("../app/api/github/repositories/route.ts", import.meta.url), "utf8");
  assert.match(source, /authenticateServerPrincipal\(/);
  assert.match(source, /CONDUCTOR_HANDOFF_SIGNING_SECRET/);
  assert.doesNotMatch(source, /readJsonBody|body\.actor|actorId/);
});

test("installation repository enumeration follows GitHub pages beyond 100 repositories", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...repository(), id: index + 1, name: `repo-${index + 1}`, full_name: `octo/repo-${index + 1}` }));
  const client = new GitHubAppClient(config, async (url) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.includes("&page=1")) return response({ repositories: firstPage });
    if (target.includes("&page=2")) return response({ repositories: [{ ...repository(), id: 101, name: "repo-101", full_name: "octo/repo-101" }] });
    return response({}, 500);
  });
  const repositories = await client.listInstallationRepositories(99);
  assert.equal(repositories.length, 101);
  assert.equal(repositories.at(-1)?.fullName, "octo/repo-101");
});

test("publication validation fails closed for protected/default targets and requires fresh checks and reviews", async () => {
  const client = new GitHubAppClient(config, async (url) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.includes("/installation/repositories")) return response({ repositories: [repository()] });
    if (target.endsWith("/repos/octo/secure-repo")) return response(repository());
    if (target.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: ["ci"] },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      enforce_admins: { enabled: true },
    });
    if (target.endsWith("/branches/feature%2Fsafe")) return response({ commit: { sha: "a".repeat(40) } });
    if (target.endsWith("/pulls/42")) return response({ state: "open", draft: false, head: { ref: "feature/safe", sha: "a".repeat(40), repo: { full_name: "octo/secure-repo" } }, base: { ref: "main" } });
    if (target.includes(`/commits/${"a".repeat(40)}/check-runs`)) return response({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
    if (target.includes(`/commits/${"a".repeat(40)}/status?per_page=100&page=1`)) return response({ statuses: [{ context: "ci", state: "success" }] });
    if (target.includes("/pulls/42/reviews?per_page=100&page=1")) return response([{ state: "APPROVED", submitted_at: "2026-08-07T00:00:00Z", commit_id: "a".repeat(40), user: { login: "reviewer" } }]);
    return response({}, 500);
  });
  const input = { workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "main", pullNumber: 42 };
  const result = await client.validatePublication(input);
  assert.deepEqual(result.policy.requiredChecks, [{ context: "ci" }]);
  assert.equal(result.policy.requiredApprovals, 1);
  await assert.rejects(() => client.validatePublication({ ...input, sourceRef: "main" }), /separate source branch/i);
});

test("publication uses the current effective check state rather than any historic success", async () => {
  const client = new GitHubAppClient(config, async (url) => {
    const target = String(url);
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.endsWith("/repos/octo/secure-repo")) return response(repository());
    if (target.endsWith("/branches/main/protection")) return response({ required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: { required_approving_review_count: 0 } });
    if (target.endsWith("/branches/feature%2Fsafe")) return response({ commit: { sha: "a".repeat(40) } });
    if (target.endsWith("/pulls/42")) return response({ state: "open", draft: false, head: { ref: "feature/safe", sha: "a".repeat(40), repo: { full_name: "octo/secure-repo" } }, base: { ref: "main" } });
    if (target.includes("/check-runs")) return response({ check_runs: [
      { id: 1, name: "ci", status: "completed", conclusion: "success", completed_at: "2026-08-07T00:00:00Z" },
      { id: 2, name: "ci", status: "completed", conclusion: "failure", completed_at: "2026-08-08T00:00:00Z" },
    ] });
    if (target.includes("/status?per_page=100&page=1")) return response({ statuses: [] });
    if (target.includes("/reviews?per_page=100&page=1")) return response([]);
    return response({}, 500);
  });
  const input = { workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "main", pullNumber: 42 };
  await assert.rejects(() => client.validatePublication(input), /checks are not passing/i);
});

test("publication policy pagination reads check runs, status contexts, and reviews beyond page 100", async () => {
  const calls: string[] = [];
  const hundred = (value: Record<string, unknown>) => Array.from({ length: 100 }, (_, index) => ({ ...value, id: index + 1 }));
  const client = new GitHubAppClient(config, async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.endsWith("/repos/octo/secure-repo")) return response(repository());
    if (target.endsWith("/branches/main/protection")) return response({ required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: { required_approving_review_count: 1 } });
    if (target.endsWith("/branches/feature%2Fsafe")) return response({ commit: { sha: "a".repeat(40) } });
    if (target.endsWith("/pulls/42")) return response({ state: "open", draft: false, head: { ref: "feature/safe", sha: "a".repeat(40), repo: { full_name: "octo/secure-repo" } }, base: { ref: "main" } });
    if (target.includes("/check-runs?per_page=100&page=1")) return response({ check_runs: hundred({ name: "other", status: "completed", conclusion: "success" }) });
    if (target.includes("/check-runs?per_page=100&page=2")) return response({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
    if (target.includes("/status?per_page=100&page=1")) return response({ statuses: hundred({ context: "other", state: "success" }) });
    if (target.includes("/status?per_page=100&page=2")) return response({ statuses: [{ context: "ci", state: "success" }] });
    if (target.includes("/reviews?per_page=100&page=1")) return response(hundred({ state: "COMMENTED" }));
    if (target.includes("/reviews?per_page=100&page=2")) return response([{ state: "APPROVED", submitted_at: "2026-08-09T00:00:00Z", commit_id: "a".repeat(40), user: { login: "reviewer" } }]);
    return response({}, 500);
  });
  await client.validatePublication({ workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "main", pullNumber: 42 });
  for (const endpoint of ["check-runs", "status", "reviews"]) {
    assert.equal(calls.some((url) => url.includes(`/${endpoint}`) && url.includes("page=2")), true, `${endpoint} page 2 was not requested`);
  }
});

test("protected merge revalidates then uses a request-scoped installation token and reviewed SHA", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new GitHubAppClient(config, async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.endsWith("/repos/octo/secure-repo")) return response(repository());
    if (target.endsWith("/branches/main/protection")) return response({ required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: { required_approving_review_count: 1 } });
    if (target.endsWith("/branches/feature%2Fsafe")) return response({ commit: { sha: "a".repeat(40) } });
    if (target.endsWith("/pulls/42")) return response({ state: "open", draft: false, head: { ref: "feature/safe", sha: "a".repeat(40), repo: { full_name: "octo/secure-repo" } }, base: { ref: "main" } });
    if (target.includes("/check-runs")) return response({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] });
    if (target.includes("/status?per_page=100&page=1")) return response({ statuses: [] });
    if (target.includes("/reviews?per_page=100&page=1")) return response([{ state: "APPROVED", submitted_at: "2026-08-08T00:00:00Z", commit_id: "a".repeat(40), user: { login: "reviewer" } }]);
    if (target.endsWith("/pulls/42/merge")) return response({ merged: true, sha: "b".repeat(40) });
    return response({}, 500);
  });
  const input = { workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "main", pullNumber: 42 };
  const validation = await client.validatePublication(input);
  const merged = await client.mergeProtectedPullRequest(input, validation.policyDigest);
  assert.equal(merged.mergeSha, "b".repeat(40));
  const merge = calls.find((call) => call.url.endsWith("/pulls/42/merge"));
  assert.equal(merge?.init?.method, "PUT");
  assert.equal(new Headers(merge?.init?.headers).get("authorization"), "Bearer installation-only-token");
  assert.equal(merge?.init?.body, JSON.stringify({ sha: "a".repeat(40), merge_method: "squash" }));
});

test("stale publication retries reconcile an already-merged matching PR without a second mutation", async () => {
  const calls: string[] = [];
  const client = new GitHubAppClient(config, async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/access_tokens")) return response({ token: "installation-only-token" }, 201);
    if (target.endsWith("/repos/octo/secure-repo")) return response(repository());
    if (target.endsWith("/branches/main/protection")) return response({ required_status_checks: { contexts: [] }, required_pull_request_reviews: { required_approving_review_count: 0 } });
    if (target.endsWith("/branches/feature%2Fsafe")) return response({ commit: { sha: "a".repeat(40) } });
    if (target.endsWith("/pulls/42")) return response({ state: "closed", merged: true, merge_commit_sha: "b".repeat(40), head: { ref: "feature/safe", sha: "a".repeat(40) }, base: { ref: "main" } });
    return response({}, 500);
  });
  const input = { workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "main", pullNumber: 42 };
  const merged = await client.mergeProtectedPullRequest(input, "policy-digest-from-permit");
  assert.equal(merged.reconciled, true);
  assert.equal(merged.mergeSha, "b".repeat(40));
  assert.equal(calls.some((target) => target.endsWith("/pulls/42/merge")), false);
});

test("publication permits are short-lived, actor-bound, and cannot expand the reviewed payload", async () => {
  const input = { actorId: "human:ada", workspaceId: "workspace_local", installationId: 99, repository: "octo/secure-repo", sourceRef: "feature/safe", headSha: "a".repeat(40), targetBranch: "release", pullNumber: 42, policyDigest: "b".repeat(64) };
  const token = await issuePublicationPermit(input, config.publicationSigningSecret, 1_700_000_000_000);
  const permit = await verifyPublicationPermit(token, input, config.publicationSigningSecret, 1_700_000_100_000);
  assert.equal(permit.actorId, "human:ada");
  await assert.rejects(() => verifyPublicationPermit(token, { ...input, actorId: "human:mallory" }, config.publicationSigningSecret, 1_700_000_100_000));
  await assert.rejects(() => verifyPublicationPermit(token, { ...input, headSha: "c".repeat(40) }, config.publicationSigningSecret, 1_700_000_100_000));
  await assert.rejects(() => verifyPublicationPermit(token, input, config.publicationSigningSecret, 1_700_000_400_001));
});

test("webhooks verify the exact raw bytes and reject invalid signatures", async () => {
  const raw = new TextEncoder().encode('{"pull_request":{"updated_at":"2023-11-14T22:13:20.000Z"}}');
  const signature = `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`;
  await verifyGitHubWebhook(raw, signature, config.webhookSecret);
  await assert.rejects(() => verifyGitHubWebhook(raw, "sha256=00", config.webhookSecret));
  await assert.rejects(() => verifyGitHubWebhook(new TextEncoder().encode(`${new TextDecoder().decode(raw)} `), signature, config.webhookSecret));
  assert.notEqual(await digestGitHubWebhookBody(raw), await digestGitHubWebhookBody(new TextEncoder().encode(`${new TextDecoder().decode(raw)} `)));
});
