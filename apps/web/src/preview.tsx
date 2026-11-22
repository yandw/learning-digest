import { createRoot } from "react-dom/client";
import { App as AntDesignApp, ConfigProvider } from "antd";
import zhCN from "antd/es/locale/zh_CN";
import AuthLayout, { libraryTheme } from "./AuthLayout";
import CodeBoxes from "./CodeBoxes";
import LibraryHome from "./LibraryHome";
import ResourceDetail from "./ResourceDetail";
import AdminSurface from "./AdminSurface";
import { Button, Form, Input } from "antd";
import "./styles.css";

const resources: any[] = [
  {
    resource: { id: "res_1", title: "注意力机制详解", kind: "video" },
    sources: [
      {
        id: "src_1",
        url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
        platformId: "bilibili",
        platformVideoId: "BV1ab411L78c",
        lastStudiedAtMs: Date.now() - 86400000 * 2,
        durationMs: 1560000,
        progress: { positionMs: 250000, revision: 1 },
      },
    ],
  },
  {
    resource: { id: "res_2", title: "Figma 自动布局完全指南", kind: "web" },
    sources: [
      {
        id: "src_2",
        url: "https://example.com/figma-auto-layout",
        platformId: null,
        lastStudiedAtMs: Date.now() - 86400000 * 9,
        durationMs: null,
      },
    ],
  },
];

const detailState: any = {
  busy: false,
  generating: false,
  detail: {
    resource: { id: "res_1", title: "注意力机制详解", kind: "video", createdAt: "2026-11-10T08:00:00Z" },
    sources: [
      {
        id: "src_1",
        resourceId: "res_1",
        kind: "video",
        url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
        platformId: "bilibili",
        progress: { positionMs: 250000, revision: 1 },
      },
    ],
    notes: [{ id: "note_1", sourceId: "src_1", positionMs: 65000, text: "注意 Q、K、V 的角色。" }],
    sessions: [
      {
        id: "ses_1",
        resourceId: "res_1",
        sourceId: "src_1",
        startedAt: "2026-11-10T08:30:00Z",
        segments: [
          { id: "seg_1", startMs: 65000, endMs: 70000, text: "注意力会选择重要的信息", revisedText: null },
          { id: "seg_2", startMs: 70000, endMs: 76000, text: "然后把这些信息加权融合到表示里。", revisedText: null },
        ],
      },
    ],
    summaries: [],
  },
  summaries: [],
  summaryDetails: {},
  summariesError: "",
  activeSummaryId: null,
};

const adminState: any = {
  view: "ready",
  error: "",
  rows: [
    { platformId: "bilibili", label: "哔哩哔哩", captions: true, asr: true, enabled: true, changedKeys: [], saveState: "idle" },
    { platformId: "youtube", label: "YouTube", captions: true, asr: false, enabled: true, changedKeys: ["asr"], saveState: "idle" },
  ],
};

function Shell({ children, label }: any) {
  return (
    <div style={{ marginBottom: 48 }}>
      <div className="board-label" style={{ font: "600 11px/1 var(--ld-mono-font)", letterSpacing: ".14em", color: "#8B8574", margin: "0 auto 10px", width: "min(1120px, calc(100% - 48px))" }}>{label}</div>
      {children}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ConfigProvider locale={zhCN} theme={libraryTheme}>
    <AntDesignApp>
      <div style={{ paddingTop: 24 }}>
        <Shell label="B3 · 登录 / 邮箱 (W03)">
          <AuthLayout labelledBy="loginTitle">
            <h1 id="loginTitle">登录学习库</h1>
            <p className="login-lede">使用受邀邮箱接收验证码，无需密码。</p>
            <Form layout="vertical" requiredMark={false}>
              <Form.Item label="邮箱" required>
                <Input aria-label="邮箱" placeholder="name@example.com" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block>
                获取验证码
              </Button>
            </Form>
            <div className="login-links">
              <Button type="link" className="login-link-accent">重新发送</Button>
              <Button type="link">更换邮箱</Button>
            </div>
          </AuthLayout>
        </Shell>
        <Shell label="B3b · 登录 / 验证码 (W04)">
          <AuthLayout labelledBy="codeTitle">
            <h1 id="codeTitle">验证邮箱</h1>
            <p className="login-lede">
              验证码已发送至 <strong>name@example.com</strong>，10 分钟内有效。
            </p>
            <Form layout="vertical" requiredMark={false}>
              <Form.Item label="验证码">
                <CodeBoxes value="481" onChange={() => {}} />
              </Form.Item>
              <Button type="primary" htmlType="submit" block>
                登录学习库
              </Button>
            </Form>
            <div className="login-links">
              <Button type="link">重新发送 (58s)</Button>
              <Button type="link">更换邮箱</Button>
            </div>
          </AuthLayout>
        </Shell>
        <Shell label="B1 · 学习库">
          <header className="app-header">
            <div className="top-navigation">
              <a className="brand" href="/">Learning Digest</a>
              <span className="library-nav-label">我的学习库</span>
            </div>
          </header>
          <main className="app-content">
            <LibraryHome
              resources={resources}
              active
              busy={false}
              error={null}
              onReload={() => {}}
              onCollect={() => Promise.resolve()}
              onOpen={() => Promise.resolve()}
              onDelete={() => Promise.resolve()}
            />
          </main>
        </Shell>
        <Shell label="B2 · 课程详情">
          <main className="app-content">
            <div className="content-inner">
              <ResourceDetail
                state={detailState}
                onBack={() => {}}
                onRetitle={async () => true}
                onGenerate={() => Promise.resolve()}
                onShowSummary={() => Promise.resolve()}
                onDelete={() => {}}
              />
            </div>
          </main>
        </Shell>
        <Shell label="B5 · 站点管理">
          <main className="app-content">
            <div className="content-inner">
              <header className="page-heading">
                <h1>站点管理</h1>
                <p>按平台控制字幕抓取、语音转写与启用状态。</p>
              </header>
              <AdminSurface state={adminState} onToggle={() => {}} onSave={async () => {}} />
            </div>
          </main>
        </Shell>
      </div>
    </AntDesignApp>
  </ConfigProvider>
);
