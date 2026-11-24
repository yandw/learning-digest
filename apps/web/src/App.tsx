import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntDesignApp,
  Button,
  ConfigProvider,
  Form,
  Grid,
  Input,
  Layout,
  Modal,
  Popover,
  Space,
  Spin,
  Typography,
} from "antd";
import zhCN from "antd/es/locale/zh_CN";
import { EllipsisOutlined, PlusOutlined } from "@ant-design/icons";
import { presentUsage } from "../public/js/library.js";
import { shouldShowAdminEntry } from "../public/js/admin.js";
import { createLearningRuntime, type LearningRuntime } from "./runtime";
import ResourceDetail from "./ResourceDetail";
import AdminSurface from "./AdminSurface";
import AuthLayout, { libraryTheme } from "./AuthLayout";
import CodeBoxes from "./CodeBoxes";
import LibraryHome from "./LibraryHome";

const { Header, Content } = Layout;

function LearningLibrary({ runtime }: { runtime: LearningRuntime }) {
  const compactHeader = Grid.useBreakpoint().xs === true;
  const [ready, setReady] = useState(false);
  const [loginState, setLoginState] = useState(runtime.login.getState());
  const [libraryState, setLibraryState] = useState(runtime.library.getState());
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectError, setCollectError] = useState("");
  const [collectUrl, setCollectUrl] = useState("");
  const [collectTitle, setCollectTitle] = useState("");
  const [surface, setSurface] = useState<"library" | "admin">("library");
  const [account, setAccount] = useState<any>(null);
  const [adminState, setAdminState] = useState(runtime.admin?.getState() || { view: "idle", rows: [] });
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usage, setUsage] = useState<ReturnType<typeof presentUsage> | null>(null);
  const [usageError, setUsageError] = useState("");
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{
    id: string;
    surface: "list" | "detail";
  } | null>(null);

  const listPosition = useRef(0);

  const refresh = useCallback(() => {
    setLoginState(runtime.login.getState());
    setLibraryState(runtime.library.getState());
    if (runtime.admin) setAdminState(runtime.admin.getState());
  }, [runtime]);

  const loadAccount = useCallback(async () => {
    if (!runtime.api?.me) return;
    const result = await runtime.api.me();
    if (result.ok && result.data?.account) {
      setAccount(result.data.account);
    } else if (result.status !== 401) {
      setAccount(null);
    }
  }, [runtime]);

  const openResource = useCallback(async (id: string, updateUrl = true) => {
    if (updateUrl) listPosition.current = window.scrollY;
    const pending = runtime.openDetail(id);
    setLibraryState(runtime.library.getState());
    await pending;
    refresh();
    if (updateUrl && runtime.library.getState().detail?.resource.id === id) {
      window.history.pushState({}, "", `/?resource=${encodeURIComponent(id)}`);
      window.scrollTo(0, 0);
    }
  }, [refresh, runtime]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const resumed = await runtime.login.resume();
      if (resumed.state === "authenticated") {
        await Promise.all([runtime.library.load(), loadAccount()]);
      }
      if (!active) return;
      refresh();
      setReady(true);
      const resourceId = new URLSearchParams(window.location.search).get("resource");
      if (resourceId && runtime.login.getState().state === "authenticated") {
        await openResource(resourceId, false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadAccount, openResource, refresh, runtime]);

  useEffect(() => runtime.subscribeSessionExpired?.(() => {
    setAccount(null);
    setSurface("library");
    setUsageOpen(false);
    setCollectOpen(false);
    setConfirmDeleteTarget(null);
    setCollectUrl("");
    setCollectTitle("");
    refresh();
  }), [refresh, runtime]);

  useEffect(() => {
    if (!runtime.session) return;
    const onFocus = () => void runtime.session.onPageVisible(true);
    const onVisibility = () => void runtime.session.onPageVisible(document.visibilityState === "visible");
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runtime]);

  const submitEmail = async () => {
    const pending = runtime.login.submitEmail(email);
    setLoginState(runtime.login.getState());
    const result = await pending;
    if (result.ok) {
      setCode("");
      setCodeSent(true);
      setResendCooldown(60);
    }
    refresh();
  };

  const resendCode = async () => {
    const target = runtime.login.getState().email || email;
    if (!target) return;
    const pending = runtime.login.submitEmail(target);
    setLoginState(runtime.login.getState());
    const result = await pending;
    if (result.ok) {
      setCode("");
      setCodeSent(true);
      setResendCooldown(60);
    }
    refresh();
  };

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => setResendCooldown((s) => s - 1), 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown > 0]);

  const submitCode = async () => {
    const pending = runtime.login.submitCode(code);
    setLoginState(runtime.login.getState());
    const result = await pending;
    if (result.ok && runtime.login.getState().state === "authenticated") {
      await Promise.all([runtime.library.load(), loadAccount()]);
    }
    refresh();
  };

  const backToEmail = () => {
    runtime.login.backToEmail();
    setCode("");
    refresh();
  };

  const logout = async () => {
    const pending = runtime.login.logout();
    setLoginState(runtime.login.getState());
    await pending;
    runtime.library.reset();
    runtime.admin?.reset();
    setAccount(null);
    setSurface("library");
    setUsageOpen(false);
    setConfirmDeleteTarget(null);
    setCollectOpen(false);
    setCollectUrl("");
    setCollectTitle("");
    refresh();
  };

  const collect = async () => {
    const pending = runtime.library.collect({ url: collectUrl, title: collectTitle });
    setLibraryState(runtime.library.getState());
    const result = await pending;
    if (result.ok) {
      setCollectUrl("");
      setCollectTitle("");
      setCollectOpen(false);
    } else {
      setCollectError(runtime.library.getState().error);
    }
    refresh();
  };

  const openCollect = () => {
    setCollectError("");
    setCollectOpen(true);
  };

  const reloadLibrary = async () => {
    const pending = runtime.library.load();
    setLibraryState(runtime.library.getState());
    await pending;
    refresh();
  };

  const showSurface = async (key: "library" | "admin") => {
    setSurface(key);
    if (key === "admin" && runtime.admin) {
      const pending = runtime.admin.load();
      setAdminState(runtime.admin.getState());
      await pending;
      refresh();
    }
  };

  const toggleCapability = (platformId: string, field: string, value: boolean) => {
    runtime.admin?.setToggle(platformId, field, value);
    refresh();
  };

  const saveCapability = async (platformId: string) => {
    if (!runtime.admin) return;
    const pending = runtime.admin.saveRow(platformId);
    setAdminState(runtime.admin.getState());
    await pending;
    refresh();
  };

  const loadUsage = async () => {
    if (!runtime.api?.getUsage) return;
    setUsageLoading(true);
    setUsageError("");
    const result = await runtime.api.getUsage();
    setUsageLoading(false);
    if (result.status === 401) return;
    if (result.ok) {
      setUsage(presentUsage(result.data));
    } else {
      setUsageError(result.data?.error?.message || "用量加载失败，请稍后重试");
    }
  };

  const backToList = () => {
    runtime.library.backToList();
    window.history.pushState({}, "", "/");
    refresh();
    window.requestAnimationFrame(() => window.scrollTo(0, listPosition.current));
  };

  const retitle = async (title: string) => {
    const detail = runtime.library.getState().detail;
    if (!detail) return false;
    const pending = runtime.library.retitle(detail.resource.id, title);
    setLibraryState(runtime.library.getState());
    const result = await pending;
    refresh();
    return Boolean(result.ok);
  };

  const generateSummary = async () => {
    const pending = runtime.library.generateSummary();
    setLibraryState(runtime.library.getState());
    await pending;
    refresh();
  };

  const showSummary = async (id: string) => {
    const pending = runtime.library.showSummary(id);
    setLibraryState(runtime.library.getState());
    await pending;
    refresh();
  };

  const armDelete = async (id: string, surface: "list" | "detail") => {
    const pending = runtime.library.deleteClick(id, surface);
    setLibraryState(runtime.library.getState());
    const result = await pending;
    if (result.armed) setConfirmDeleteTarget({ id, surface });
    refresh();
  };

  const cancelDelete = useCallback(() => {
    runtime.library.disarmDelete();
    setConfirmDeleteTarget(null);
    refresh();
  }, [refresh, runtime]);

  const confirmDelete = async () => {
    if (!confirmDeleteTarget) return;
    let pending = runtime.library.deleteClick(confirmDeleteTarget.id, confirmDeleteTarget.surface);
    setLibraryState(runtime.library.getState());
    let result = await pending;
    if (result.armed) {
      // The shared flow may auto-disarm while the modal is open. The modal's
      // explicit confirmation is the second click, so re-arm and finish it.
      pending = runtime.library.deleteClick(confirmDeleteTarget.id, confirmDeleteTarget.surface);
      setLibraryState(runtime.library.getState());
      result = await pending;
    }
    if (confirmDeleteTarget.surface === "detail" && (result.ok || result.gone)) {
      window.history.pushState({}, "", "/");
    }
    setConfirmDeleteTarget(null);
    refresh();
  };

  useEffect(() => {
    function handleHistory() {
      if (runtime.login.getState().state !== "authenticated") return;
      const id = new URLSearchParams(window.location.search).get("resource");
      setSurface("library");
      if (id) void openResource(id, false);
      else {
        runtime.library.backToList();
        refresh();
      }
    }
    window.addEventListener("popstate", handleHistory);
    return () => window.removeEventListener("popstate", handleHistory);
  }, [openResource, refresh, runtime]);

  if (!ready) {
    return (
      <div className="startup-loading" aria-label="正在恢复学习库">
        <Spin size="large" />
      </div>
    );
  }

  if (loginState.state !== "authenticated") {
    const codeStep = loginState.state === "code";
    if (codeStep) {
      return (
        <AuthLayout labelledBy="codeTitle">
          <h1 id="codeTitle">验证邮箱</h1>
          <p className="login-lede">
            验证码已发送至 <strong>{loginState.email}</strong>，10 分钟内有效。
          </p>
          {loginState.notice && (
            <Alert className="login-notice" type="success" showIcon title={loginState.notice} />
          )}
          {loginState.error && (
            <Alert className="login-notice" type="error" showIcon title={loginState.error} />
          )}
          <Form layout="vertical" onFinish={() => void submitCode()} requiredMark={false}>
            <Form.Item label="验证码">
              <CodeBoxes value={code} onChange={setCode} />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loginState.busy}
              disabled={code.length !== 6 || loginState.busy}
              autoInsertSpace={false}
            >
              登录学习库
            </Button>
          </Form>
          <div className="login-links">
            <Button
              type="link"
              className={resendCooldown > 0 ? "" : "login-link-accent"}
              disabled={resendCooldown > 0 || loginState.busy}
              onClick={() => void resendCode()}
            >
              {resendCooldown > 0 ? `重新发送 (${resendCooldown}s)` : "重新发送"}
            </Button>
            <Button type="link" disabled={loginState.busy} onClick={backToEmail}>
              更换邮箱
            </Button>
          </div>
        </AuthLayout>
      );
    }
    return (
      <AuthLayout labelledBy="loginTitle">
        <h1 id="loginTitle">登录学习库</h1>
        <p className="login-lede">使用受邀邮箱接收验证码，无需密码。</p>
        {loginState.notice && (
          <Alert className="login-notice" type="success" showIcon title={loginState.notice} />
        )}
        {loginState.error && (
          <Alert className="login-notice" type="error" showIcon title={loginState.error} />
        )}
        <Form layout="vertical" onFinish={() => void submitEmail()} requiredMark={false}>
          <Form.Item label="邮箱" required>
            <Input
              aria-label="邮箱"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              size="large"
              autoFocus
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loginState.busy} block>
            获取验证码
          </Button>
        </Form>
        <div className="login-links">
          {codeSent && (
            <Button
              type="link"
              className={resendCooldown > 0 ? "" : "login-link-accent"}
              disabled={resendCooldown > 0 || loginState.busy}
              onClick={() => void resendCode()}
            >
              {resendCooldown > 0 ? `重新发送 (${resendCooldown}s)` : "重新发送"}
            </Button>
          )}
          <Button type="link" disabled={!email} onClick={() => setEmail("")}>
            更换邮箱
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const credential = runtime.credentials.get();
  const resources = libraryState.resources || [];
  const showHome = surface === "library" && libraryState.view !== "detail";

  const accountControls = (
    <Space className={compactHeader ? "compact-account-actions" : "account-area"} orientation={compactHeader ? "vertical" : "horizontal"} size={8} wrap>
      {shouldShowAdminEntry(account) && (
        <Button type="text" onClick={() => void showSurface(surface === "admin" ? "library" : "admin")}>
          {surface === "admin" ? "返回学习库" : "站点管理"}
        </Button>
      )}
      <Button type="text" aria-label="收藏资料" icon={<PlusOutlined aria-hidden="true" />} onClick={openCollect}>收藏资料</Button>
      <Typography.Text className="account-email" title={credential?.email || ""}>
        {credential?.email || ""}
      </Typography.Text>
      {runtime.api?.getUsage && (
        <Popover
          trigger="click"
          getPopupContainer={compactHeader ? (trigger) => trigger.parentElement || document.body : undefined}
          open={usageOpen}
          onOpenChange={(open) => {
            setUsageOpen(open);
            if (open) void loadUsage();
          }}
          content={
            <div className="usage-popover" aria-live="polite">
              {usageLoading ? <Spin aria-label="用量加载中" /> : usageError ? (
                <Alert type="error" showIcon title={usageError} />
              ) : usage?.audioText ? (
                <dl className="usage-totals">
                  <dt>累计转写</dt><dd>{usage.audioText}</dd>
                  <dt>课程总结</dt><dd>{usage.summaryCount} 次</dd>
                  <dt>总结输入</dt><dd>{usage.summaryInputChars} 字符</dd>
                  <dt>更新时间</dt><dd>{usage.updatedText}</dd>
                </dl>
              ) : <Typography.Text>{usage?.text}</Typography.Text>}
            </div>
          }
        >
          <Button type="text" aria-label="用量">用量</Button>
        </Popover>
      )}
      <Button
        aria-label="退出登录"
        type="text"
        onClick={() => void logout()}
        disabled={loginState.busy}
      >
        退出登录
      </Button>
    </Space>
  );

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="top-navigation">
          <a className="brand" href="/" onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (libraryState.view === "detail") backToList();
            setSurface("library");
            void reloadLibrary();
          }}>Learning Digest</a>
          <span className="library-nav-label">我的学习库</span>
        </div>
        {compactHeader ? (
          <Popover trigger="click" placement="bottomRight" content={accountControls}>
            <Button type="text" icon={<EllipsisOutlined />} aria-label="账户与操作" />
          </Popover>
        ) : accountControls}
      </Header>
      <Content className="app-content">
        {showHome && libraryState.notice && (
          <Alert className="content-inner library-notice" type="success" showIcon title={libraryState.notice} />
        )}
        <LibraryHome
          resources={resources}
          active={showHome}
          busy={libraryState.busy}
          error={collectOpen ? null : libraryState.error}
          listNotes={runtime.api?.listNotes}
          onReload={() => void reloadLibrary()}
          onCollect={openCollect}
          onOpen={(id) => void openResource(id)}
          onDelete={(id) => void armDelete(id, "list")}
        />
        {surface === "admin" ? (
          <div className="content-inner">
            <header className="page-heading">
              <h1>站点管理</h1>
              <p>按平台控制字幕抓取、语音转写与启用状态。</p>
            </header>
            <AdminSurface state={adminState} onToggle={toggleCapability} onSave={saveCapability} />
          </div>
        ) : libraryState.view === "detail" && libraryState.detail ? (
          <div className="content-inner">
            <ResourceDetail
              state={libraryState}
              onBack={backToList}
              onRetitle={retitle}
              onGenerate={generateSummary}
              onShowSummary={showSummary}
              onReadSessionDigest={runtime.library.readSessionDigest}
              onDelete={() => void armDelete(libraryState.detail.resource.id, "detail")}
            />
          </div>
        ) : null}
      </Content>
      <Modal
        title="收藏新资料"
        open={collectOpen}
        okText="收藏"
        cancelText="取消"
        confirmLoading={libraryState.busy}
        okButtonProps={{ htmlType: "submit", form: "collect-form", autoInsertSpace: false }}
        onCancel={() => setCollectOpen(false)}
      >
        {collectError && <Alert className="login-notice" type="error" showIcon title={collectError} />}
        <Form id="collect-form" layout="vertical" onFinish={() => void collect()} requiredMark={false}>
          <Form.Item label="网页链接" htmlFor="collect-url" required>
            <Input id="collect-url" value={collectUrl} onChange={(event) => setCollectUrl(event.target.value)}
              type="url" placeholder="https://…" autoComplete="off" />
          </Form.Item>
          <Form.Item label="标题（可选）" htmlFor="collect-title">
            <Input id="collect-title" value={collectTitle} onChange={(event) => setCollectTitle(event.target.value)}
              placeholder="留空则先保存链接" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="删除这条资料？"
        open={Boolean(confirmDeleteTarget)}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={libraryState.busy}
        onOk={() => void confirmDelete()}
        onCancel={cancelDelete}
      >
        <p>将同时删除该资料的逐字稿、笔记与课程总结，此操作不可撤销。</p>
      </Modal>
    </Layout>
  );
}

export default function App({ runtime: providedRuntime }: { runtime?: LearningRuntime }) {
  const fallbackRuntime = useRef<LearningRuntime | null>(null);
  if (!providedRuntime && !fallbackRuntime.current) {
    fallbackRuntime.current = createLearningRuntime();
  }
  const runtime = providedRuntime || fallbackRuntime.current!;

  return (
    <ConfigProvider locale={zhCN} theme={libraryTheme}>
      <AntDesignApp>
        <LearningLibrary runtime={runtime} />
      </AntDesignApp>
    </ConfigProvider>
  );
}
