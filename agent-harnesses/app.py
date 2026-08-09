"""Conductor's isolated dependency probe for external agent harnesses.

This service never performs workspace mutation. It reports only frameworks that
are installed in its own image; execution adapters are enabled only after their
contract and live provider smoke test pass.
"""
from __future__ import annotations

import importlib
from fastapi import FastAPI

app = FastAPI(title="Conductor Agent Harness Suite", docs_url=None, redoc_url=None)

HARNESS_MODULES = {
    "pydantic-ai": "pydantic_ai",
    "microsoft-agent-framework": "agent_framework",
    "crewai": "crewai",
    "llamaindex": "llama_index",
    "haystack": "haystack",
    "semantic-kernel": "semantic_kernel",
}


@app.get("/health")
def health() -> dict[str, object]:
    engines = []
    for identifier, module in HARNESS_MODULES.items():
        try:
            imported = importlib.import_module(module)
            engines.append({
                "id": identifier,
                "installed": True,
                "version": getattr(imported, "__version__", "unknown"),
                "status": "pending_adapter_validation",
            })
        except Exception as error:  # surface dependency failures without hiding them
            engines.append({"id": identifier, "installed": False, "status": "unavailable", "detail": str(error)[:240]})
    return {"ok": True, "engines": engines}
