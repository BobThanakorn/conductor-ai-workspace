from __future__ import annotations

import os
import time

from fastapi import FastAPI, Header, HTTPException

from graph import configured_api_key, invoke_graph
from models import AgentProposal, AgentRequest, HealthResponse


app = FastAPI(
    title="Conductor LangGraph Agent",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
)


def _serialize_proposal(proposal: AgentProposal) -> dict[str, object]:
    payload = proposal.model_dump(mode="json", exclude_none=True)
    if proposal.execution is None:
        payload["execution"] = None
    # The shared TypeScript contract models a command batch as optional, but
    # requires at least one item when it is present.
    if not payload.get("executions"):
        payload.pop("executions", None)
    return payload


def _authorize(authorization: str | None) -> None:
    expected = os.environ.get("LANGGRAPH_INTERNAL_TOKEN", "").strip()
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid internal service credential")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    vllm_configured = bool(
        os.environ.get("VLLM_BASE_URL", "").strip()
        and os.environ.get("VLLM_MODEL", "").strip()
    )
    return HealthResponse(
        ok=True,
        engine="langchain-langgraph",
        checkpoint="sqlite",
        modelConfigured=bool(configured_api_key()) or vllm_configured,
    )


@app.post("/v1/agent")
async def run_agent(
    request: AgentRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    _authorize(authorization)
    started = time.perf_counter()
    try:
        proposal, thread_id, checkpoint_id = await invoke_graph(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "ok": True,
        "engine": "langgraph",
        "model": request.model,
        "threadId": thread_id,
        "checkpointId": checkpoint_id,
        "status": "waiting_for_approval" if proposal.needsApproval else "completed",
        "output": _serialize_proposal(proposal),
        "metrics": {
            "durationMs": round((time.perf_counter() - started) * 1_000),
        },
    }
