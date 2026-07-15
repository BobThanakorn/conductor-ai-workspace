# Conductor local companion foundation

This folder defines the security boundary for a future workspace-local execution
companion. It deliberately exposes only three typed, read-only Git capabilities:
status, diff, and log.

The companion validates a versioned command envelope, canonicalizes the
workspace root, rejects path traversal, enforces a deadline, computes an
action digest, disables prompts and pagers, caps output, and invokes Git through
an argument vector rather than a shell.

It does not yet provide mutation tools, a transport server, sandbox lifecycle,
credential injection, package installation, Git publishing, or arbitrary shell
execution. Those capabilities remain gated by the approval, sandbox, and
credential-broker phases of the roadmap.
