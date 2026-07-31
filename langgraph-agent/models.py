from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class WorkspaceFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=3, max_length=200)
    content: str = Field(max_length=32_000)

    @field_validator("path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        normalized = value.replace("\\", "/").strip("/")
        if not normalized or normalized.startswith("/") or ".." in normalized.split("/"):
            raise ValueError("path must stay inside the workspace")
        return normalized


class WorkspaceIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repository: str = Field(min_length=1, max_length=300)
    path: str | None = Field(default=None, max_length=1_000)
    branch: str | None = Field(default=None, max_length=300)
    headSha: str | None = Field(default=None, max_length=128)


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=6_000)
    mode: Literal["agent", "ask"] = "agent"
    model: str = Field(min_length=1, max_length=200)
    workspaceId: str = Field(min_length=1, max_length=128)
    taskId: str | None = Field(default=None, max_length=128)
    runId: str = Field(min_length=8, max_length=160)
    workspaceFiles: list[WorkspaceFile] = Field(default_factory=list, max_length=8)
    workspace: WorkspaceIdentity
    task: dict[str, object] | None = None


class AgentArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=3, max_length=200)
    content: str = Field(max_length=32_000)
    language: str = Field(default="text", min_length=1, max_length=32)

    @field_validator("path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        normalized = value.replace("\\", "/").strip("/")
        if not normalized or normalized.startswith("/") or ".." in normalized.split("/"):
            raise ValueError("artifact path must stay inside the workspace")
        return normalized


class ExecutionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entrypoint: str | None = Field(default=None, max_length=200)
    command: str | None = Field(default=None, max_length=4_000)
    args: list[Annotated[str, Field(max_length=256)]] = Field(default_factory=list, max_length=16)
    timeoutMs: int = Field(default=120_000, ge=100, le=300_000)

    @model_validator(mode="after")
    def require_entrypoint_or_command(self) -> "ExecutionStep":
        if not (self.entrypoint or self.command):
            raise ValueError("execution requires an entrypoint or command")
        return self


class AgentProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=1_200)
    plan: list[Annotated[str, Field(min_length=1, max_length=320)]] = Field(
        default_factory=list,
        max_length=12,
    )
    proposedAction: str = Field(default="review_agent_proposal", max_length=240)
    riskLevel: Literal["R0", "R1", "R2", "R3"] = "R1"
    needsApproval: bool = True
    evidence: list[Annotated[str, Field(min_length=1, max_length=320)]] = Field(
        default_factory=list,
        max_length=12,
    )
    artifacts: list[AgentArtifact] = Field(default_factory=list, max_length=8)
    execution: ExecutionStep | None = None
    executions: list[ExecutionStep] = Field(default_factory=list, max_length=8)


class HealthResponse(BaseModel):
    ok: bool
    engine: str
    checkpoint: str
    modelConfigured: bool
