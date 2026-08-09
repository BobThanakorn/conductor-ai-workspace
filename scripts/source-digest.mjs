import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const excludedDirectories = new Set([
  ".conductor",
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
  "work",
  "workspace",
]);

function isExcluded(relativePath, directory = false) {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => excludedDirectories.has(segment) || segment === "__pycache__")) return true;
  const base = segments.at(-1) ?? "";
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.") || base === ".mcp.env" || base.startsWith("secret.")) return true;
  if (base === ".conductor-source-digest" || base === "tsconfig.tsbuildinfo" || base.startsWith("npm-debug.log")) return true;
  if (normalized === "orchestrator/state.json" || /^orchestrator\/.*evidence.*\.json$/i.test(normalized)) return true;
  return directory && excludedDirectories.has(base);
}

async function collect(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
    if (isExcluded(relativePath, entry.isDirectory())) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolutePath, relativePath));
    else files.push({ absolutePath, relativePath });
  }
  return files;
}

const hash = createHash("sha256");
const files = (await collect(root)).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
const manifest = [];
for (const file of files) {
  const stat = await lstat(file.absolutePath);
  const content = stat.isSymbolicLink()
    ? Buffer.from(`symlink:${await readlink(file.absolutePath)}`, "utf8")
    : await readFile(file.absolutePath);
  hash.update(file.relativePath, "utf8");
  hash.update("\0");
  hash.update(String(content.length), "utf8");
  hash.update("\0");
  hash.update(content);
  hash.update("\0");
  manifest.push({ path: file.relativePath, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
}
const digest = hash.digest("hex");
process.stdout.write(process.argv.includes("--manifest") ? `${JSON.stringify({ digest, files: manifest })}\n` : `${digest}\n`);
