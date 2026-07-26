"use client";

import { FormEvent, useState } from "react";
import "./portal.css";

type ChatMessage = { id: number; role: "user" | "assistant"; text: string; meta?: string };

const initialMessages: ChatMessage[] = [
  { id: 1, role: "assistant", text: "สวัสดีครับ ผมคือ Conductor Assistant ช่วยวางแผน แก้ไข และตรวจสอบโปรเจกต์ของคุณได้", meta: "Conductor Assistant" },
  { id: 2, role: "user", text: "ช่วยตรวจสอบ workspace นี้ให้หน่อย" },
  { id: 3, role: "assistant", text: "ได้ครับ ผมพร้อมอ่านไฟล์จาก repository ที่เชื่อมต่อ และจะขอ approval ก่อนแก้ไขหรือรันคำสั่ง", meta: "Conductor Assistant" },
];

export default function PortalPage() {
  const [messages, setMessages] = useState(initialMessages);
  const [prompt, setPrompt] = useState("");
  const [activeTab, setActiveTab] = useState<"chat" | "team" | "project">("chat");
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [composerMode, setComposerMode] = useState("playground");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    setBusy(true);
    const userMessage: ChatMessage = { id: Date.now(), role: "user", text };
    setMessages((current) => [...current, userMessage]);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `portal-${Date.now()}` },
        body: JSON.stringify({
          message: text,
          mode: "ask",
          workspaceId: "workspace_local",
          idempotencyKey: `portal-${Date.now()}`,
          workspace: { repository: "Local workspace" },
        }),
      });
      const data = await response.json() as { output?: { summary?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message || "Agent request failed");
      setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: data.output?.summary || "Agent response received.", meta: "Conductor Assistant" }]);
    } catch (error) {
      setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: error instanceof Error ? error.message : "ไม่สามารถเชื่อมต่อ Agent ได้", meta: "System" }]);
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setMessages([{ id: Date.now(), role: "assistant", text: "เริ่มแชตใหม่ได้เลยครับ บอกสิ่งที่ต้องการให้ผมช่วยได้ทันที", meta: "Conductor Assistant" }]);
    setNotice("New chat created");
    window.setTimeout(() => setNotice(""), 2400);
  }

  return (
    <main className="portal-shell">
      <aside className="portal-sidebar" aria-label="Project navigation">
        <div className="portal-label">PROJECT</div>
        <button className="project-card" type="button">
          <span className="project-avatar">AE</span>
          <span><strong>AI Engineering</strong><small>Member · 2 teams</small></span>
          <b>⌄</b>
        </button>
        <button className="new-chat" type="button" onClick={newChat}><span>＋</span> New chat</button>
        <div className="portal-label manage-label">MANAGE</div>
        <button className="sidebar-link" type="button" onClick={() => setNotice("Connectors & skills manager is ready for the next integration phase")}>♧ <span>Connectors & skills</span></button>
        <button className="sidebar-link" type="button" onClick={() => setNotice("Project settings")}>☷ <span>Settings</span></button>
        <div className="portal-label recent-label">RECENT CHATS</div>
        <div className="privacy-line">⌕ Private to you</div>
        <button className="recent-chat selected" type="button"><i /> <span><strong>My week at a glance</strong><small>Created /workspace/hello.txt</small></span></button>
        <button className="recent-chat" type="button"><i /> <span><strong>Vendor email translation</strong><small>Done · translation ready</small></span></button>
        <button className="recent-chat" type="button"><i /> <span><strong>Workspace review</strong><small>Agent proposal ready for review</small></span></button>
        <div className="sidebar-spacer" />
        <button className="profile-card" type="button"><span className="profile-avatar">ธ</span><span><strong>ผู้ใช้ Conductor</strong><small>Project member</small></span><b>›</b></button>
      </aside>

      <section className="portal-main">
        <header className="portal-header">
          <div className="portal-tabs" role="tablist" aria-label="Portal sections">
            <button type="button" className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>◌ <span>Chat</span></button>
            <button type="button" className={activeTab === "team" ? "active" : ""} onClick={() => setActiveTab("team")}>♧ <span>Team</span></button>
            <button type="button" className={activeTab === "project" ? "active" : ""} onClick={() => setActiveTab("project")}>▣ <span>Project</span></button>
          </div>
          <div className="header-status"><span className="personal-dot" /> Personal <span className="active-users">● 6 active</span></div>
        </header>

        <div className="portal-content">
          <div className="chat-column">
            {activeTab !== "chat" ? (
              <div className="tab-empty"><span>{activeTab === "team" ? "♧" : "▣"}</span><h1>{activeTab === "team" ? "Team workspace" : "Project overview"}</h1><p>ส่วนนี้แยกจาก Code Workspace เดิม และพร้อมต่อยอดระบบสมาชิก/โปรเจกต์จริง</p></div>
            ) : (
              <>
                <div className="assistant-heading"><span className="assistant-avatar">AI</span><div><strong>DTS Assistant</strong><small>Your personal workspace assistant</small></div></div>
                <div className="message-list">
                  {messages.map((message) => (
                    <article className={`portal-message ${message.role}`} key={message.id}>
                      {message.role === "user" ? <span className="user-avatar">ธ</span> : <span className="assistant-avatar small">AI</span>}
                      <div><div className="message-meta">{message.meta || "ผู้ใช้"}</div><p>{message.text}</p></div>
                    </article>
                  ))}
                  {busy && <div className="typing"><span /> <span /> <span /> Agent กำลังประมวลผล…</div>}
                </div>
                <form className="portal-composer" onSubmit={sendMessage}>
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Message the DTS assistant… (Shift+Enter for newline)" rows={2} aria-label="Message the DTS assistant" />
                  <div className="composer-toolbar">
                    <button type="button" onClick={() => setNotice("แนบไฟล์จะเชื่อมกับ repository context ในขั้นถัดไป")}>＋ Attach</button>
                    <button type="button" onClick={() => setNotice("Skills manager เปิดจากเมนู Connectors & skills")}>♧ Skills</button>
                    <button type="button" className={composerMode === "playground" ? "selected" : ""} onClick={() => setComposerMode("playground")}>›_ playground</button>
                    <button type="button" className={composerMode === "preview" ? "selected" : ""} onClick={() => setComposerMode("preview")}>↗ preview</button>
                    <button type="button" className={composerMode === "files" ? "selected" : ""} onClick={() => setComposerMode("files")}>▱ files</button>
                    <span className="composer-spacer" /><span className="portal-model">gpt-5.4-mini</span>
                    <button className="send-message" type="submit" aria-label="Send message" disabled={!prompt.trim() || busy}>↑</button>
                  </div>
                </form>
                <div className="sandbox-note">{composerMode === "playground" ? "Playground mode — reviewed commands run inside the local workspace sandbox." : `${composerMode} mode selected — choose a file or preview from the workspace.`}</div>
              </>
            )}
          </div>

          {workspaceOpen && <aside className="portal-workspace" aria-label="Workspace files">
            <div className="workspace-heading"><strong>▱ workspace</strong><div><button type="button" aria-label="Refresh workspace" onClick={() => setNotice("Workspace refreshed")}>↻</button><button type="button" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}>×</button></div></div>
            <div className="workspace-section-label">FILES <span>3</span></div>
            <button className="workspace-file" type="button"><span>◫</span><strong>CLAUDE.md</strong><small>927 B</small></button>
            <button className="workspace-file" type="button"><span>◫</span><strong>hello.txt</strong><small>14 B</small></button>
            <button className="workspace-file" type="button"><span>◫</span><strong>README.md</strong><small>2.1 KB</small></button>
            <div className="workspace-divider" />
            <div className="workspace-section-label">AGENT RUN</div>
            <div className="run-card"><span className="run-dot" /><div><strong>Ready for review</strong><small>Approval-gated · local</small></div></div>
            <button className="open-old-workspace" type="button" onClick={() => window.location.assign("/")}>Open Code Workspace →</button>
          </aside>}
          {!workspaceOpen && <button className="workspace-reopen" type="button" onClick={() => setWorkspaceOpen(true)}>▱ Workspace</button>}
        </div>
      </section>
      {notice && <div className="portal-notice" role="status">✓ {notice}</div>}
    </main>
  );
}
