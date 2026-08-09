# Production images and Compose profiles

Images are deliberately local-only in this repository. `0.1.0` is the human-readable release version; Dockerfiles also pin their Node, Python, and MCP Gateway bases by immutable digest. Building, scanning, and smoke testing never push, sign, or publish an image.

Use exactly one profile:

- `minimal`: web, both private companions, and LangGraph. It has no ready model provider without runtime credentials.
- `full`: minimal plus the Docker MCP Gateway.
- `benchmark`: full runtime plus the six external benchmark harnesses.

Examples:

```powershell
docker compose --profile minimal config
docker compose -f compose.yaml -f compose.mcp.yaml --profile full config
docker compose -f compose.yaml -f compose.mcp.yaml -f compose.harnesses.yaml --profile benchmark config
pwsh ./scripts/fresh-machine-smoke.ps1
pwsh ./scripts/container-evidence.ps1
```

Runtime secrets are Compose secrets or environment values supplied by the operator. They are excluded from the Docker build context and are never copied in any Dockerfile. The fresh-machine smoke creates unique, empty runtime secret files only for its isolated Compose project, verifies no model reports ready without credentials, and removes that project and its volumes afterwards.

`container-evidence.ps1` writes inspect, history, SPDX SBOM, and SARIF vulnerability artifacts under `artifacts/container-evidence/`. The web build stores a deterministic digest of its reviewed build inputs at `/app/.conductor-source-digest`; the evidence gate recomputes that digest from the current checkout and rejects stale images. The gate also fails closed when Docker Scout is unavailable, any artifact is missing or invalid, an artifact belongs to an outdated image ID, an image runs as root, or a secret marker appears in image history. Slow workstations can scan one image at a time with `-Images <image>` and finish with `-AggregateOnly`; the aggregate command still requires current evidence for all nine images. CI pins third-party actions to immutable commit SHAs and treats missing evidence as an error.
