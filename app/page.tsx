import type { Metadata } from "next";
import WorkspaceClient from "./workspace-client";

export const metadata: Metadata = {
  title: "Conductor — AI engineering workspace",
  description:
    "A secure workspace for planning, reviewing, and shipping work with coding agents.",
};

export default function Home() {
  return <WorkspaceClient />;
}
