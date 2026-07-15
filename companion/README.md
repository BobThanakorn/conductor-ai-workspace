# Conductor local companion foundation

This folder defines the security boundary for a future workspace-local execution
companion. It deliberately exposes only three typed, read-only Git capabilities:
status, diff, and log.

The companion validates a versioned command envelope, enforces an exact
capability-to-command mapping, canonicalizes the workspace root, rejects path
traversal, enforces a deadline, computes an action digest, and caps stdout and
stderr independently. It invokes the literal `git` executable with a fixed
read-only verb and validated argument vector (`shell: false`). Repository-driven
pagers, prompts, filesystem monitors, external diff drivers, text conversion,
and optional index locks are disabled.

It does not yet provide mutation tools, a transport server, sandbox lifecycle,
credential injection, package installation, Git publishing, or arbitrary shell
execution. Those capabilities remain gated by the approval, sandbox, and
credential-broker phases of the roadmap.

An action digest is an integrity binding, not an authorization signature. A
future authenticated transport must validate grants, expiry, nonce reuse, and
policy before calling this bridge. OS-level sandboxing is still required to
close filesystem race and process-isolation boundaries.
