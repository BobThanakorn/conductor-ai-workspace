import { createHash, timingSafeEqual } from "node:crypto";

const ACTION_DIGEST_DOMAIN = "ai-environment.action.v1\0";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type ActionDigest = `sha256:${string}`;

export interface ActionDigestClaims {
  readonly commandId: string;
  readonly policyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly workspace: {
    readonly canonicalRoot: string;
    readonly snapshotId: string | null;
  };
  readonly capability: string;
  readonly action: {
    readonly name: string;
    readonly input: unknown;
  };
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function createActionDigest(claims: ActionDigestClaims): ActionDigest {
  const canonical = canonicalJson({
    schemaVersion: "companion.action-digest.v1",
    ...claims,
  });
  const hex = createHash("sha256")
    .update(ACTION_DIGEST_DOMAIN, "utf8")
    .update(canonical, "utf8")
    .digest("hex");
  return `sha256:${hex}`;
}

export function actionDigestMatches(
  expected: ActionDigest,
  observed: string,
): boolean {
  if (!DIGEST_PATTERN.test(expected) || !DIGEST_PATTERN.test(observed)) {
    return false;
  }
  const left = Buffer.from(expected.slice(7), "hex");
  const right = Buffer.from(observed.slice(7), "hex");
  return timingSafeEqual(left, right);
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("Non-finite numbers are not canonical JSON.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError(`Unsupported canonical JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalizationError("Cyclic values are not canonical JSON.");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
          throw new CanonicalizationError("Arrays may not have custom properties.");
        }
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new CanonicalizationError("Sparse arrays are not canonical JSON.");
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError("Only plain objects are canonical JSON.");
    }
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) {
      throw new CanonicalizationError("Symbol keys are not canonical JSON.");
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new CanonicalizationError("Accessors are not canonical JSON.");
      }
      return `${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
