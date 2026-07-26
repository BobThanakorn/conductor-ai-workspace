import type { Metadata } from "next";
import WorkspaceClient from "../workspace-client";

export const metadata: Metadata = {
  title: "Conductor — Code Workspace",
  description: "Code-first review, diff, terminal and approval workspace.",
};

export default function CodeWorkspacePage() {
  return <WorkspaceClient />;
}
