import { mutationPayloadSchema, type AgentMutationPayload } from "../lib/agent-contract.ts";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Contract-bound input must be an object.");
  return value as JsonRecord;
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/^python(?=\s|$)/i, "python3");
}

function assertArtifactBinding(body: JsonRecord, mutation: AgentMutationPayload, action: string): void {
  const operation = mutation.operations.find((entry) => entry.action === action);
  if (!operation) throw new Error(`Contract v2 does not authorize companion action ${action}.`);
  const approvedInput = record(operation.input);
  if (action === "fs.write") {
    const files = body.files;
    if (!Array.isArray(files)) throw new Error("Contract-bound fs.write requires files.");
    const expectedInputFiles = approvedInput.files;
    if (!Array.isArray(expectedInputFiles)) throw new Error("Contract v2 fs.write operation is invalid.");
    const expected = expectedInputFiles.map((item) => {
      const value = record(item);
      if (typeof value.path !== "string" || typeof value.content !== "string") throw new Error("Contract v2 fs.write operation is invalid.");
      return { path: value.path, content: value.content };
    });
    const actual = files.map((item) => {
      const value = record(item);
      if (typeof value.path !== "string" || typeof value.content !== "string") throw new Error("Contract-bound fs.write files are invalid.");
      return { path: value.path, content: value.content };
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("fs.write input does not match the approved Contract v2 artifacts.");
  }
  if (action === "terminal.execute-batch") {
    const commands = body.commands;
    if (!Array.isArray(commands)) throw new Error("Contract-bound terminal.execute-batch requires commands.");
    const expectedInputCommands = approvedInput.commands;
    if (!Array.isArray(expectedInputCommands)) throw new Error("Contract v2 terminal operation is invalid.");
    const expected = expectedInputCommands.map((item) => {
      const value = record(item);
      if (typeof value.command !== "string") throw new Error("Contract v2 terminal operation is invalid.");
      return normalizeCommand(value.command);
    });
    const actual = commands.map((item) => {
      const value = record(item);
      if (typeof value.command !== "string") throw new Error("Contract-bound command is invalid.");
      return normalizeCommand(value.command);
    });
    if (actual.length !== expected.length || actual.some((command, index) => command !== expected[index])) {
      throw new Error("terminal.execute-batch input does not match the approved Contract v2 executions.");
    }
  }
}

export function parseContractMutation(body: JsonRecord, action: string): AgentMutationPayload | null {
  const hasVersion = body.contractVersion !== undefined || body.contractMutation !== undefined;
  if (!hasVersion) return null;
  if (body.contractVersion !== 2) throw new Error("Only Contract v2 approval payloads are supported.");
  const mutation = mutationPayloadSchema.parse(body.contractMutation);
  assertArtifactBinding(body, mutation, action);
  return mutation;
}

export function validateContractBoundInput(
  body: JsonRecord,
  action: string,
  currentHeadSha?: string,
): AgentMutationPayload | null {
  const mutation = parseContractMutation(body, action);
  if (!mutation || !mutation.snapshot.headSha) return mutation;
  const expected = mutation.snapshot.headSha.toLowerCase();
  if (!currentHeadSha || !currentHeadSha.toLowerCase().startsWith(expected)) {
    throw new Error("Contract v2 snapshot is stale; refresh the repository context before applying the proposal.");
  }
  return mutation;
}
