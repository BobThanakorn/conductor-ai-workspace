import type { ActionDigest } from "./action-digest";

export const COMPANION_SCHEMA_VERSION = "companion.command.v1" as const;
export const COMPANION_RESULT_SCHEMA_VERSION = "companion.result.v1" as const;

export type RiskTier = "R0" | "R1" | "R2" | "R3" | "FORBIDDEN";
export type SideEffectClass =
  | "none"
  | "local-reversible"
  | "persistent-or-external"
  | "high-blast-radius"
  | "forbidden";

export const READ_CAPABILITIES = {
  "git.read.status": {
    risk: "R0",
    sideEffect: "none",
    description: "Read repository and worktree status.",
  },
  "git.read.diff": {
    risk: "R0",
    sideEffect: "none",
    description: "Read a bounded textual Git diff.",
  },
  "git.read.log": {
    risk: "R0",
    sideEffect: "none",
    description: "Read bounded commit history.",
  },
} as const satisfies Readonly<
  Record<string, { risk: RiskTier; sideEffect: SideEffectClass; description: string }>
>;

export type ReadCapabilityId = keyof typeof READ_CAPABILITIES;
export type CapabilityId = ReadCapabilityId;

export interface CapabilityGrant<TCapability extends CapabilityId = CapabilityId> {
  readonly schemaVersion: "companion.capability-grant.v1";
  readonly grantId: string;
  readonly capability: TCapability;
  readonly canonicalWorkspaceRoot: string;
  readonly issuedTo: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly singleUse: boolean;
}

export interface CommandEnvelope<
  TName extends string,
  TCapability extends CapabilityId,
  TInput,
> {
  readonly schemaVersion: typeof COMPANION_SCHEMA_VERSION;
  readonly kind: "companion.command";
  readonly commandId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly policyVersion: string;
  readonly workspace: {
    readonly root: string;
    readonly snapshotId?: string;
  };
  readonly capability: TCapability;
  readonly command: {
    readonly name: TName;
    readonly input: TInput;
  };
}

export type CommandErrorCode =
  | "INVALID_COMMAND"
  | "CAPABILITY_MISMATCH"
  | "DEADLINE_EXCEEDED"
  | "WORKSPACE_INVALID"
  | "NOT_A_REPOSITORY"
  | "GIT_UNAVAILABLE"
  | "GIT_FAILED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "PARSE_FAILED"
  | "INTERNAL_ERROR";

export interface ExecutionEvidence {
  readonly actionDigest: ActionDigest;
  readonly canonicalWorkspaceRoot: string;
  readonly executable: string;
  readonly arguments: readonly string[];
}

interface CommandResultBase<TName extends string> {
  readonly schemaVersion: typeof COMPANION_RESULT_SCHEMA_VERSION;
  readonly kind: "companion.result";
  readonly commandId: string;
  readonly commandName: TName;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface CommandSuccess<TName extends string, TValue>
  extends CommandResultBase<TName> {
  readonly ok: true;
  readonly value: TValue;
  readonly evidence: ExecutionEvidence;
}

export interface CommandFailure<TName extends string>
  extends CommandResultBase<TName> {
  readonly ok: false;
  readonly error: {
    readonly code: CommandErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  };
  readonly evidence?: ExecutionEvidence;
}

export type CommandResult<TName extends string, TValue> =
  | CommandSuccess<TName, TValue>
  | CommandFailure<TName>;

export class ContractValidationError extends Error {
  readonly code: CommandErrorCode = "INVALID_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export function isReadCapabilityId(value: unknown): value is ReadCapabilityId {
  return typeof value === "string" && value in READ_CAPABILITIES;
}

export function validateCommandEnvelopeBasics(
  value: unknown,
): asserts value is CommandEnvelope<string, ReadCapabilityId, unknown> {
  if (!isPlainRecord(value)) {
    throw new ContractValidationError("Command must be a plain object.");
  }

  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "commandId",
    "issuedAt",
    "expiresAt",
    "policyVersion",
    "workspace",
    "capability",
    "command",
  ]);

  if (value.schemaVersion !== COMPANION_SCHEMA_VERSION) {
    throw new ContractValidationError("Unsupported command schema version.");
  }
  if (value.kind !== "companion.command") {
    throw new ContractValidationError("Invalid command kind.");
  }
  assertIdentifier(value.commandId, "commandId");
  assertIdentifier(value.policyVersion, "policyVersion");
  const issuedAt = parseCanonicalTimestamp(value.issuedAt, "issuedAt");
  const expiresAt = parseCanonicalTimestamp(value.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    throw new ContractValidationError("expiresAt must be later than issuedAt.");
  }
  if (!isReadCapabilityId(value.capability)) {
    throw new ContractValidationError("Unknown or non-read capability.");
  }

  if (!isPlainRecord(value.workspace)) {
    throw new ContractValidationError("workspace must be a plain object.");
  }
  assertExactKeys(value.workspace, ["root", "snapshotId"], ["snapshotId"]);
  if (
    typeof value.workspace.root !== "string" ||
    value.workspace.root.length === 0 ||
    value.workspace.root.length > 4096
  ) {
    throw new ContractValidationError("workspace.root is invalid.");
  }
  if (
    value.workspace.snapshotId !== undefined &&
    (typeof value.workspace.snapshotId !== "string" ||
      value.workspace.snapshotId.length === 0 ||
      value.workspace.snapshotId.length > 256)
  ) {
    throw new ContractValidationError("workspace.snapshotId is invalid.");
  }

  if (!isPlainRecord(value.command)) {
    throw new ContractValidationError("command must be a plain object.");
  }
  assertExactKeys(value.command, ["name", "input"]);
  if (
    typeof value.command.name !== "string" ||
    value.command.name.length === 0 ||
    value.command.name.length > 128
  ) {
    throw new ContractValidationError("command.name is invalid.");
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractValidationError(`Unexpected field: ${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new ContractValidationError(`Missing required field: ${key}`);
    }
  }
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new ContractValidationError(`${name} is invalid.`);
  }
}

function parseCanonicalTimestamp(value: unknown, name: string): number {
  if (typeof value !== "string") {
    throw new ContractValidationError(`${name} must be a timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new ContractValidationError(`${name} must be canonical UTC ISO-8601.`);
  }
  return timestamp;
}
