# Conductor

Conductor is a security-first AI coding workspace where a human reviews agent
proposals before the execution companion changes a real repository.

## Capabilities

- OpenAI Agents SDK orchestration with Azure AI Foundry as the preferred model
  provider and an OpenAI-compatible alternative.
- A parallel LangChain + LangGraph orchestration service using the same Azure
  model configuration, proposal contract, approval policy, repository state,
  Git/GitHub integration, and execution companion behavior.
- Complete, multi-language file proposals rendered in the editor before apply.
- Real repository filesystem tree/read/write/delete through the companion.
- Real terminal execution with stdout, stderr, exit code, timeout, and duration.
- Git status, diff, commit, fetch, pull, push, branch, checkout, and merge.
- GitHub pull-request creation through the provider API.
- Payload-bound, short-lived, single-use approval tokens for every mutation.
- Fail-closed provider and companion behavior: unavailable dependencies produce
  an explicit error and never generate a simulated proposal or repository result.
- Docker Compose packaging with a shared workspace volume, health checks,
  non-root execution, dropped Linux capabilities, and resource limits.
- D1-backed task, approval, event, and idempotency records for the hosted UI.

## Run with Docker Compose

Copy `.env.example` to an ignored `.env`. Set `WORKSPACE_PATH` to the repository
the agent may change and add only the credentials you need. Keys are injected at
runtime and are not embedded in the image.

```bash
docker compose up --build
```

Provider and tool configurations follow the layered Compose pattern used by
Docker's Compose for Agents examples. Use one override at a time:

```bash
# Azure AI Foundry key from ./secret.azure-api-key
docker compose -f compose.yaml -f compose.azure.yaml up --build

# OpenAI key from ./secret.openai-api-key
docker compose -f compose.yaml -f compose.openai.yaml up --build

# Docker Model Runner (requires Docker Desktop/Engine model support)
docker compose -f compose.yaml -f compose.model.yaml up --build

# Add Docker MCP Gateway and GitHub Official MCP tools
docker compose -f compose.yaml -f compose.azure.yaml -f compose.mcp.yaml up --build

# Add GitHub push and pull-request credentials to the companion
docker compose -f compose.yaml -f compose.azure.yaml -f compose.github.yaml up --build
```

## Agent engines

The portal can run the same request through either:

- `OpenAI Agents SDK` — the existing TypeScript orchestration engine.
- `LangChain + LangGraph` — an isolated Python service with SQLite-backed
  LangGraph checkpoints.

Both engines return the same reviewed proposal schema. Neither engine writes
files, runs commands, or performs Git mutations directly. The browser requests
a payload-bound approval from the selected execution companion before any
side effect. The LangGraph engine uses a second companion on port `8766` so
the two engines never share mutable repository-selection state.

Start the complete local system:

```powershell
docker compose up -d --build
```

Health checks:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8766/health
Invoke-RestMethod http://127.0.0.1:3000/api/models
```

Run the comparable Ask-mode benchmark after both engines report `ready`:

```powershell
npm run benchmark:agents
```

The machine-readable report is written to
`outputs/agent-sdk-benchmark.json`. Use the same model, prompt, workspace
snapshot, iteration count, and runtime limits when interpreting the results.

The MCP gateway is optional. Both agent engines filter its tool catalog to
read/list/search/fetch/query operations. Repository writes, shell commands,
remote Git publication, and pull requests stay behind Conductor's one-time
approval flow.

To expose both Azure and a local vLLM model in the model picker, configure both
providers. The selected Qwen model is routed to vLLM while Azure remains the
default for the configured GPT model:

```env
AZURE_AI_FOUNDRY_MODEL=gpt-5.1-codex-mini
VLLM_BASE_URL=http://host.docker.internal:9020/v1
VLLM_API_KEY=EMPTY
VLLM_MODEL=Qwen/Qwen3.6-35B-A3B
CONDUCTOR_MODEL_OPTIONS=gpt-5.1-codex-mini,Qwen/Qwen3.6-35B-A3B
```

The vLLM endpoint must be reachable from the web container. Use
`http://localhost:9020/v1` for host development and
`http://host.docker.internal:9020/v1` from Docker Desktop.

Open `http://localhost:3000`. Check the execution companion with:

```bash
curl http://127.0.0.1:8765/health
```

The mounted repository remains on the host. Terminal and Git commands execute
inside the companion container, not directly on the host operating system.

## Share the image

```bash
docker build -t your-registry/conductor:1.0 .
docker push your-registry/conductor:1.0
```

Recipients set `CONDUCTOR_IMAGE=your-registry/conductor:1.0`, configure their
own `WORKSPACE_PATH` and secrets, then run `docker compose up`.

## Local development

```bash
npm install
npm run dev
```

Keep the execution companion running in a second terminal:

```bash
npm run companion:git
```

Host development exposes filesystem and Git capabilities. Generic terminal
execution is disabled on the host by default. Opt in only when intended:

```bash
CONDUCTOR_ALLOW_HOST_EXECUTION=true npm run companion:git
```

Docker Compose sets the safer container execution mode automatically.

## Provider configuration

```bash
AZURE_AI_FOUNDRY_ENDPOINT=https://ai-environment-resource.services.ai.azure.com
AZURE_AI_FOUNDRY_API_KEY=replace-with-your-key
AZURE_AI_FOUNDRY_MODEL=gpt-5.1-codex-mini
```

`OPENAI_API_KEY` and `OPENAI_MODEL` configure an optional alternate provider. `GITHUB_TOKEN`
enables GitHub HTTPS authentication and pull-request creation. Never commit
credential values.

An authenticated OpenAI-compatible vLLM server on a private network can be used
with:

```bash
OPENAI_BASE_URL=http://10.0.0.10:9020/v1
OPENAI_AGENT_MODEL=your-vllm-model-id
docker compose -f compose.yaml -f compose.openai.yaml up --build
```

Put its bearer token in `secret.openai-api-key`. Custom OpenAI-compatible
endpoints use Chat Completions with bounded output and thinking disabled so
structured coding proposals complete within the UI request window. Unencrypted
HTTP endpoints are accepted only on loopback, Docker-local, or RFC1918 private
network addresses; use HTTPS for public hosts.

For Docker secrets, copy the matching `.example` file without the `.example`
suffix and replace its single line with the key. Docker mounts it under
`/run/secrets`; the entrypoint loads it only into the relevant service process.
The local Wrangler runtime imports that server process environment as Worker
bindings; provider credentials remain server-side and are never returned to the browser.

## Try it

Enter a task in the prompt box, for example:

```text
สร้างไฟล์ hello.py ให้พิมพ์ Hello from Python แล้วรันและแสดงผลลัพธ์
```

Inspect the complete proposal and select **Approve, apply & run**. With the
companion connected, the files are written into the mounted repository and the
verification command runs in the container. The Terminal also accepts explicit
commands such as `npm test`, `python3 main.py`, `git pull`, and `git push`; every
run requires a new approval bound to that exact command.

## Verification

```bash
npm run typecheck
npm run lint
npm test
docker compose config
docker compose build
```

## Security boundary

- Model output is a proposal, never authorization.
- The browser never receives model-provider credentials.
- Writes, deletes, terminal commands, commits, remote Git operations, and pull
  requests consume an exact-payload, single-use approval token.
- Workspace paths reject absolute paths and traversal.
- Generic shell commands run only in container mode unless a host operator
  explicitly opts in.
- The companion container runs as a non-root user, drops all Linux capabilities,
  applies process/memory/CPU ceilings, and mounts only the selected workspace.
- Git credential prompts are disabled so unattended authentication fails closed.
- Hidden chain-of-thought is neither requested nor persisted.

See [`companion/README.md`](companion/README.md) for the endpoint and approval
protocol boundary.
