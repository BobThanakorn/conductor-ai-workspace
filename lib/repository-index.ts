import { redactSensitiveText } from "./agent-safety.ts";

export const DEFAULT_INDEX_CHUNK_CHARS = 4_000;
export const DEFAULT_INDEX_MAX_FILES = 500;
export const DEFAULT_CONTEXT_MAX_FILES = 8;
export const DEFAULT_CONTEXT_MAX_TOKENS = 12_000;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "work",
  "outputs",
  "test-results",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
  ".jks",
  ".sqlite",
  ".db",
  ".map",
  ".min.js",
  ".min.css",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".sql": "sql",
  ".sh": "shell",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".html": "html",
};

export type RepositorySourceFile = { path: string; content: string };

export type RepositoryChunk = {
  id: string;
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  content: string;
  snapshotId: string;
  fileHash: string;
};

export type RepositoryIndex = {
  snapshotId: string;
  files: number;
  chunks: RepositoryChunk[];
  excluded: Array<{ path: string; reason: string }>;
};

export type ContextManifest = {
  snapshotId: string;
  query: string;
  selectedChunks: number;
  selectedFiles: string[];
  estimatedTokens: number;
  tokenBudget: number;
  excludedFiles: number;
};

export type RetrievedRepositoryContext = {
  files: RepositorySourceFile[];
  manifest: ContextManifest;
};

function extension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".min.js")) return ".min.js";
  if (lower.endsWith(".min.css")) return ".min.css";
  const index = lower.lastIndexOf(".");
  return index >= 0 ? lower.slice(index) : "";
}

function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extension(path)] ?? "text";
}

function compactHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

export function shouldIndexRepositoryPath(inputPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = normalizePath(inputPath);
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false, reason: "absolute_path" };
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "..")) return { ok: false, reason: "unsafe_path" };
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return { ok: false, reason: "generated_or_dependency_directory" };
  const fileName = lowerSegments.at(-1) ?? "";
  if (EXCLUDED_FILE_NAMES.has(fileName) || fileName.startsWith(".env.")) return { ok: false, reason: "secret_file" };
  if (EXCLUDED_EXTENSIONS.has(extension(fileName))) return { ok: false, reason: "binary_or_generated_file" };
  if (fileName.endsWith(".lock") || fileName.endsWith(".snap")) return { ok: false, reason: "generated_file" };
  return { ok: true, path };
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const pattern = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of content.matchAll(pattern)) {
    const symbol = match[1] ?? match[2];
    if (symbol) symbols.add(symbol);
    if (symbols.size >= 40) break;
  }
  return [...symbols];
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_$.-]+/u).filter((token) => token.length >= 3))];
}

export function chunkRepositoryFile(
  file: RepositorySourceFile,
  snapshotId: string,
  options: { maxChars?: number; overlapLines?: number } = {},
): RepositoryChunk[] {
  const maxChars = Math.max(500, Math.min(options.maxChars ?? DEFAULT_INDEX_CHUNK_CHARS, 12_000));
  const overlapLines = Math.max(0, Math.min(options.overlapLines ?? 3, 12));
  const safePath = shouldIndexRepositoryPath(file.path);
  if (!safePath.ok) return [];
  const content = redactSensitiveText(file.content).replace(/\u0000/g, " ");
  const lines = content.split(/\r?\n/);
  const chunks: RepositoryChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && (end === start || chars + lines[end].length + 1 <= maxChars)) {
      chars += lines[end].length + 1;
      end += 1;
    }
    const chunkContent = lines.slice(start, end).join("\n");
    chunks.push({
      id: `${snapshotId}:${safePath.path}:${start + 1}-${end}:${compactHash(chunkContent)}`,
      path: safePath.path,
      language: languageForPath(safePath.path),
      startLine: start + 1,
      endLine: end,
      symbols: extractSymbols(chunkContent),
      content: chunkContent,
      snapshotId,
      fileHash: compactHash(content),
    });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

export function buildRepositoryIndex(
  files: readonly RepositorySourceFile[],
  snapshotId: string,
  options: { maxFiles?: number; maxChars?: number } = {},
): RepositoryIndex {
  const chunks: RepositoryChunk[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_INDEX_MAX_FILES, 5_000));
  const seen = new Set<string>();
  let indexedFiles = 0;
  for (const file of files) {
    const safePath = shouldIndexRepositoryPath(file.path);
    if (!safePath.ok) {
      excluded.push({ path: normalizePath(file.path), reason: safePath.reason });
      continue;
    }
    if (seen.has(safePath.path)) continue;
    seen.add(safePath.path);
    if (indexedFiles >= maxFiles) {
      excluded.push({ path: safePath.path, reason: "file_limit" });
      continue;
    }
    const fileChunks = chunkRepositoryFile({ ...file, path: safePath.path }, snapshotId, { maxChars: options.maxChars });
    if (fileChunks.length === 0) {
      excluded.push({ path: safePath.path, reason: "empty_or_unsupported" });
      continue;
    }
    indexedFiles += 1;
    chunks.push(...fileChunks);
  }
  return { snapshotId, files: indexedFiles, chunks, excluded };
}

/** Re-index only changed files while retaining provenance for unchanged chunks. */
export function updateRepositoryIndex(
  previous: RepositoryIndex | undefined,
  files: readonly RepositorySourceFile[],
  snapshotId: string,
  options: { maxFiles?: number; maxChars?: number } = {},
): RepositoryIndex {
  if (!previous) return buildRepositoryIndex(files, snapshotId, options);
  const previousByPath = new Map<string, RepositoryChunk[]>();
  for (const chunk of previous.chunks) {
    const chunks = previousByPath.get(chunk.path) ?? [];
    chunks.push(chunk);
    previousByPath.set(chunk.path, chunks);
  }
  const changedOrNew = files.map((file) => {
    const safePath = shouldIndexRepositoryPath(file.path);
    if (!safePath.ok) return { file, safePath };
    const redacted = redactSensitiveText(file.content).replace(/\u0000/g, " ");
    const cached = previousByPath.get(safePath.path);
    if (cached?.[0]?.fileHash === compactHash(redacted)) {
      return {
        file,
        safePath,
        cached: cached.map((chunk) => ({
          ...chunk,
          id: `${snapshotId}:${chunk.path}:${chunk.startLine}-${chunk.endLine}:${chunk.fileHash}`,
          snapshotId,
        })),
      };
    }
    return { file, safePath };
  });
  const indexableFiles: Array<{ entry: typeof changedOrNew[number]; chunks: RepositoryChunk[] }> = [];
  for (const entry of changedOrNew) {
    if (!entry.safePath.ok) continue;
    indexableFiles.push({
      entry,
      chunks: entry.cached ?? chunkRepositoryFile({ ...entry.file, path: entry.safePath.path }, snapshotId, { maxChars: options.maxChars }),
    });
  }
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_INDEX_MAX_FILES, 5_000));
  const retained = indexableFiles.slice(0, maxFiles);
  const excluded = changedOrNew
    .filter((entry) => !entry.safePath.ok)
    .map((entry) => ({ path: normalizePath(entry.file.path), reason: entry.safePath.ok ? "" : entry.safePath.reason }));
  return {
    snapshotId,
    files: retained.filter((entry) => entry.chunks.length > 0).length,
    chunks: retained.flatMap((entry) => entry.chunks),
    excluded,
  };
}

function scoreChunk(chunk: RepositoryChunk, queryTokens: readonly string[]): number {
  const pathTokens = tokenize(chunk.path);
  const symbolTokens = tokenize(chunk.symbols.join(" "));
  const contentTokens = tokenize(chunk.content);
  let score = 0;
  for (const token of queryTokens) {
    if (pathTokens.includes(token)) score += 12;
    if (symbolTokens.includes(token)) score += 9;
    if (contentTokens.includes(token)) score += 2;
  }
  return score;
}

function provenanceHeader(chunk: RepositoryChunk): string {
  return `// context lines ${chunk.startLine}-${chunk.endLine} from snapshot ${chunk.snapshotId}`;
}

export function retrieveRepositoryContext(
  index: RepositoryIndex,
  query: string,
  options: { maxFiles?: number; maxTokens?: number } = {},
): RetrievedRepositoryContext {
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_CONTEXT_MAX_FILES, 32));
  const tokenBudget = Math.max(256, Math.min(options.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS, 64_000));
  const queryTokens = tokenize(query);
  const ranked = index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine);
  const selected: RepositoryChunk[] = [];
  const selectedPaths = new Set<string>();
  let usedTokens = 0;
  for (const candidate of ranked) {
    if (candidate.score === 0 && selected.length > 0) break;
    if (!selectedPaths.has(candidate.chunk.path) && selectedPaths.size >= maxFiles) continue;
    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens <= 0) break;
    // The model receives provenance headers and separators as part of the
    // file content, so reserve those characters before truncating the chunk.
    const overheadChars = provenanceHeader(candidate.chunk).length + 1 + (selected.length > 0 ? 2 : 0);
    const maxChars = Math.max(0, remainingTokens * 4 - overheadChars);
    if (maxChars < 1) break;
    const content = candidate.chunk.content.length > maxChars
      ? candidate.chunk.content.slice(0, maxChars)
      : candidate.chunk.content;
    const selectedChunk = content === candidate.chunk.content
      ? candidate.chunk
      : { ...candidate.chunk, content };
    const estimatedTokens = Math.ceil((overheadChars + selectedChunk.content.length) / 4);
    if (estimatedTokens <= 0 || usedTokens + estimatedTokens > tokenBudget) continue;
    selected.push(selectedChunk);
    selectedPaths.add(candidate.chunk.path);
    usedTokens += estimatedTokens;
  }
  const grouped = new Map<string, string[]>();
  for (const chunk of selected.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine)) {
    const lines = grouped.get(chunk.path) ?? [];
    lines.push(`${provenanceHeader(chunk)}\n${chunk.content}`);
    grouped.set(chunk.path, lines);
  }
  const files = [...grouped.entries()].map(([path, parts]) => ({ path, content: parts.join("\n\n").slice(0, 32_000) }));
  return {
    files,
    manifest: {
      snapshotId: index.snapshotId,
      query: query.slice(0, 500),
      selectedChunks: selected.length,
      selectedFiles: files.map((file) => file.path),
      estimatedTokens: usedTokens,
      tokenBudget,
      excludedFiles: index.excluded.length,
    },
  };
}
