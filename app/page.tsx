import type { Metadata } from "next";
import PortalPage from "./portal/page";

export const metadata: Metadata = {
  title: "Conductor — AI workspace",
  description: "Chat-first AI engineering workspace with an integrated repository panel.",
};

export default function Home() {
  return <PortalPage />;
}
