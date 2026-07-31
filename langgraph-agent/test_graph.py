from __future__ import annotations

import unittest
from unittest.mock import patch

from app import _serialize_proposal
from graph import READ_ONLY_TOOL, _mcp_gateway_url, policy_node, prepare_node
from models import AgentProposal, AgentRequest


def request(mode: str = "agent") -> AgentRequest:
    return AgentRequest(
        message="Create hello.py",
        mode=mode,
        model="gpt-test",
        workspaceId="workspace_local",
        taskId="task_test",
        runId="run_test_123",
        workspaceFiles=[],
        workspace={"repository": "workspace", "branch": "main", "headSha": "abc"},
    )


class GraphPolicyTests(unittest.TestCase):
    def test_prepare_is_snapshot_bound(self) -> None:
        result = prepare_node({"request": request().model_dump(), "messages": []})
        self.assertEqual(len(result["snapshot_hash"]), 64)

    def test_ask_mode_is_forced_read_only(self) -> None:
        proposal = AgentProposal(
            summary="answer",
            riskLevel="R2",
            needsApproval=True,
            artifacts=[{"path": "hello.py", "content": "print('x')", "language": "python"}],
        )
        result = policy_node(
            {"request": request("ask").model_dump(), "proposal": proposal.model_dump()}
        )
        output = AgentProposal.model_validate(result["proposal"])
        self.assertEqual(output.riskLevel, "R0")
        self.assertFalse(output.needsApproval)
        self.assertEqual(output.artifacts, [])

    def test_write_is_never_r0(self) -> None:
        proposal = AgentProposal(
            summary="write",
            riskLevel="R0",
            needsApproval=False,
            artifacts=[{"path": "hello.py", "content": "print('x')", "language": "python"}],
        )
        result = policy_node(
            {"request": request().model_dump(), "proposal": proposal.model_dump()}
        )
        output = AgentProposal.model_validate(result["proposal"])
        self.assertEqual(output.riskLevel, "R1")
        self.assertTrue(output.needsApproval)

    def test_shell_control_characters_are_rejected(self) -> None:
        proposal = AgentProposal(
            summary="unsafe",
            execution={"command": "python3 hello.py; rm -rf /", "timeoutMs": 1000},
        )
        with self.assertRaises(ValueError):
            policy_node(
                {"request": request().model_dump(), "proposal": proposal.model_dump()}
            )

    def test_empty_execution_batch_is_omitted_for_shared_contract(self) -> None:
        payload = _serialize_proposal(AgentProposal(summary="answer", executions=[]))
        self.assertNotIn("executions", payload)
        self.assertIn("execution", payload)

    def test_bare_executable_is_combined_and_duplicate_is_removed(self) -> None:
        step = {
            "command": "python",
            "args": ["outputs/smoke.py"],
            "timeoutMs": 1_000,
        }
        proposal = AgentProposal(
            summary="run",
            execution=step,
            executions=[step],
        )
        result = policy_node(
            {"request": request().model_dump(), "proposal": proposal.model_dump()}
        )
        output = AgentProposal.model_validate(result["proposal"])
        self.assertEqual(output.execution.command, "python outputs/smoke.py")
        self.assertEqual(output.execution.args, [])
        self.assertEqual(output.executions, [])

    def test_bare_entrypoint_is_converted_to_complete_command(self) -> None:
        proposal = AgentProposal(
            summary="run",
            artifacts=[
                {
                    "path": "outputs/smoke.py",
                    "content": "print('ok')",
                    "language": "python",
                }
            ],
            execution={
                "entrypoint": "python",
                "args": ["outputs/smoke.py"],
                "timeoutMs": 1_000,
            },
        )
        result = policy_node(
            {"request": request().model_dump(), "proposal": proposal.model_dump()}
        )
        output = AgentProposal.model_validate(result["proposal"])
        self.assertIsNone(output.execution.entrypoint)
        self.assertEqual(output.execution.command, "python outputs/smoke.py")

    def test_mcp_gateway_is_limited_to_trusted_transport(self) -> None:
        with patch.dict(
            "os.environ",
            {"MCP_GATEWAY_URL": "http://mcp-gateway:8811"},
            clear=False,
        ):
            self.assertEqual(_mcp_gateway_url(), "http://mcp-gateway:8811")
        with patch.dict(
            "os.environ",
            {"MCP_GATEWAY_URL": "http://public.example/mcp"},
            clear=False,
        ):
            with self.assertRaises(RuntimeError):
                _mcp_gateway_url()

    def test_only_read_only_mcp_tool_names_are_allowed(self) -> None:
        self.assertIsNotNone(READ_ONLY_TOOL.match("get_repository"))
        self.assertIsNotNone(READ_ONLY_TOOL.match("search_code"))
        self.assertIsNone(READ_ONLY_TOOL.match("create_issue"))
        self.assertIsNone(READ_ONLY_TOOL.match("delete_repository"))


if __name__ == "__main__":
    unittest.main()
