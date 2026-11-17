import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntDesignApp,
  Button,
  ConfigProvider,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Popover,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import zhCN from "antd/es/locale/zh_CN";
import {
  BookOutlined,
  DeleteOutlined,
  LinkOutlined,
  LogoutOutlined,
  PlusOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { DELETE_CONFIRM_MS, presentListItem, presentUsage } from "../public/js/library.js";
import { shouldShowAdminEntry } from "../public/js/admin.js";
import { createLearningRuntime, type LearningRuntime } from "./runtime";
import ResourceDetail from "./ResourceDetail";
import AdminSurface from "./AdminSurface";

const { Header, Content, Sider } = Layout;

function LearningLibrary({ runtime }: { runtime: LearningRuntime }) {
  const [ready, setReady] = useState(false);
  const [loginState, setLoginState] = useState(runtime.login.getState());
  const [libraryState, setLibraryState] = useState(runtime.library.getState());
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [collectUrl, setCollectUrl] = useState("");
  const [collectTitle, setCollectTitle] = useState("");
  const [surface, setSurface] = useState<"library" | "admin">("library");
  const [account, setAccount] = useState<any>(null);
  const [adminState, setAdminState] = useState(runtime.admin?.getState() || { view: "idle", rows: [] });
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageText, setUsageText] = useState("");
  const [usageError, setUsageError] = useState("");
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{
    id: string;
    surface: "list" | "detail";
  } | null>(null);

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
    const pending = runtime.openDetail(id);
    setLibraryState(runtime.library.getState());
    await pending;
    refresh();
    if (updateUrl) {
      window.history.pushState({}, "", `/?resource=${encodeURIComponent(id)}`);
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
    await pending;
    setCode("");
    refresh();
  };

  const submitCode = async () => {
    const pending = runtime.login.submitCode(code);
    setLoginState(runtime.login.getState());
    const result = await pending;
    if (result.ok && runtime.login.getState().state === "authenticated") {
      await Promise.all([runtime.library.load(), loadAccount()]);
    }
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
    refresh();
  };

  const collect = async () => {
    const pending = runtime.library.collect({ url: collectUrl, title: collectTitle });
    setLibraryState(runtime.library.getState());
    const result = await pending;
    if (result.ok) {
      setCollectUrl("");
      setCollectTitle("");
    }
    refresh();
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
      setUsageText(presentUsage(result.data).text);
    } else {
      setUsageError(result.data?.error?.message || "用量加载失败，请稍后重试");
    }
  };

  const backToList = () => {
    runtime.library.backToList();
    window.history.pushState({}, "", "/");
    refresh();
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
    if (confirmDeleteTarget.surface === "detail") {
      window.history.pushState({}, "", "/");
    }
    setConfirmDeleteTarget(null);
    refresh();
  };

  useEffect(() => {
    if (!confirmDeleteTarget) return;
    const timer = window.setTimeout(cancelDelete, DELETE_CONFIRM_MS + 100);
    return () => window.clearTimeout(timer);
  }, [cancelDelete, confirmDeleteTarget]);

  if (!ready) {
    return (
      <div className="startup-loading" aria-label="正在恢复学习库">
        <Spin size="large" />
      </div>
    );
  }

  if (loginState.state !== "authenticated") {
    const codeStep = loginState.state === "code";
    return (
      <main className="login-shell">
        <section className="login-panel" aria-labelledby="loginTitle">
          <div className="login-brand">
            <div className="brand" style={{ padding: 0, minHeight: 0 }}>
              <span className="brand-mark" aria-hidden="true">L</span>
              <span>Learning Digest</span>
            </div>
          </div>
          <h1 id="loginTitle">登录学习库</h1>
          <p className="login-lede">使用受邀邮箱接收验证码，继续你的学习记录。</p>
          {loginState.notice && (
            <Alert className="login-notice" type="success" showIcon title={loginState.notice} />
          )}
          {loginState.error && (
            <Alert className="login-notice" type="error" showIcon title={loginState.error} />
          )}
          {codeStep ? (
            <Form layout="vertical" onFinish={() => void submitCode()} requiredMark={false}>
              <Form.Item label="验证码" required>
                <Input
                  aria-label="验证码"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="输入 6 位验证码"
                  size="large"
                  autoFocus
                />
              </Form.Item>
              <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loginState.busy}
                  autoInsertSpace={false}
                  block
                >
                  登录
                </Button>
                <Button
                  type="link"
                  onClick={() => {
                    runtime.login.backToEmail();
                    setCode("");
                    refresh();
                  }}
                  disabled={loginState.busy}
                  block
                >
                  更换邮箱
                </Button>
              </Space>
            </Form>
          ) : (
            <Form layout="vertical" onFinish={() => void submitEmail()} requiredMark={false}>
              <Form.Item label="邮箱" required>
                <Input
                  aria-label="邮箱"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  size="large"
                  autoFocus
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={loginState.busy} block>
                获取验证码
              </Button>
            </Form>
          )}
        </section>
      </main>
    );
  }

  const credential = runtime.credentials.get();
  const resources = libraryState.resources || [];
  const loading = libraryState.busy && resources.length === 0;

  return (
    <Layout className="app-shell">
      <Sider className="app-sider" width={224} breakpoint="lg" collapsedWidth={0} trigger={null}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>Learning Digest</span>
        </div>
        <Menu
          className="app-menu"
          mode="inline"
          selectedKeys={[surface]}
          items={[
            { key: "library", icon: <BookOutlined aria-hidden="true" />, label: "学习列表" },
            ...(shouldShowAdminEntry(account)
              ? [{ key: "admin", icon: <SettingOutlined aria-hidden="true" />, label: "站点管理" }]
              : []),
          ]}
          onClick={({ key }) => {
            if (key === "library" && surface === "library") void reloadLibrary();
            else void showSurface(key as "library" | "admin");
          }}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="mobile-brand">Learning Digest</div>
          <Space className="account-area" size={16}>
            <Typography.Text className="account-email" title={credential?.email || ""}>
              {credential?.email || ""}
            </Typography.Text>
            {runtime.api?.getUsage && (
              <Popover
                trigger="click"
                open={usageOpen}
                onOpenChange={(open) => {
                  setUsageOpen(open);
                  if (open) void loadUsage();
                }}
                content={
                  <div className="usage-popover" aria-live="polite">
                    {usageLoading ? <Spin aria-label="用量加载中" /> : usageError ? (
                      <Alert type="error" showIcon title={usageError} />
                    ) : <Typography.Text>{usageText}</Typography.Text>}
                  </div>
                }
              >
                <Button aria-label="用量">用量</Button>
              </Popover>
            )}
            <Button
              aria-label="退出登录"
              icon={<LogoutOutlined />}
              onClick={() => void logout()}
              disabled={loginState.busy}
            >
              退出登录
            </Button>
          </Space>
        </Header>
        <Content className="app-content">
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
                onDelete={() => void armDelete(libraryState.detail.resource.id, "detail")}
              />
            </div>
          ) : (
          <div className="content-inner">
            <header className="page-heading">
              <h1>学习列表</h1>
              <p>收藏课程与网页，继续上一次的学习位置。</p>
            </header>

            <section className="collect-panel" aria-labelledby="collectHeading">
              <h2 id="collectHeading">收藏新资料</h2>
              <p className="section-intro">粘贴网页或课程链接，标题可以留空稍后补充。</p>
              <Form layout="vertical" onFinish={() => void collect()} requiredMark={false}>
                <div className="collect-grid">
                  <Form.Item label="网页链接" required>
                    <Input
                      aria-label="网页链接"
                      prefix={<LinkOutlined />}
                      value={collectUrl}
                      onChange={(event) => setCollectUrl(event.target.value)}
                      type="url"
                      placeholder="https://www.bilibili.com/video/…"
                      autoComplete="off"
                    />
                  </Form.Item>
                  <Form.Item label="标题（可选）">
                    <Input
                      aria-label="标题（可选）"
                      value={collectTitle}
                      onChange={(event) => setCollectTitle(event.target.value)}
                      placeholder="留空则先保存链接"
                      autoComplete="off"
                    />
                  </Form.Item>
                  <Form.Item className="collect-submit" label=" ">
                    <Button
                      type="primary"
                      htmlType="submit"
                      aria-label="收藏"
                      icon={<PlusOutlined />}
                      loading={libraryState.busy}
                    >
                      收藏
                    </Button>
                  </Form.Item>
                </div>
              </Form>
            </section>

            {(libraryState.notice || libraryState.error) && (
              <div className="feedback-stack">
                {libraryState.notice && <Alert type="success" showIcon title={libraryState.notice} />}
                {libraryState.error && <Alert type="error" showIcon title={libraryState.error} />}
              </div>
            )}

            <section className="list-panel" aria-labelledby="resourceHeading">
              <div className="list-panel-header">
                <h2 id="resourceHeading">我的资料</h2>
                <span className="list-count">{resources.length} 条</span>
              </div>
              {loading ? (
                <div className="list-loading"><Spin /></div>
              ) : (
                resources.length === 0 ? (
                  <Empty
                    className="resource-empty"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      <Space orientation="vertical" size={4}>
                        <span>收藏的网页和课程会出现在这里。</span>
                        <Typography.Text type="secondary">粘贴一个链接开始收藏。</Typography.Text>
                      </Space>
                    }
                  />
                ) : (
                  <ul className="resource-list">
                    {resources.map((item: any) => {
                      const presented = presentListItem(item);
                      return (
                        <li className="resource-item" key={presented.id}>
                          <div className="resource-item-main">
                            {presented.href ? (
                              <a
                                className="resource-title"
                                href={presented.href}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {presented.title}
                              </a>
                            ) : (
                              <span className="resource-title">{presented.title}</span>
                            )}
                            <div>
                              <Space className="resource-meta" size={8} wrap>
                                <Tag>{presented.kindLabel}</Tag>
                                {presented.platformLabel && <Tag color="cyan">{presented.platformLabel}</Tag>}
                                {presented.progressText && (
                                  <Typography.Text type="secondary">{presented.progressText}</Typography.Text>
                                )}
                              </Space>
                            </div>
                          </div>
                          <div className="resource-actions">
                            <Button type="link" onClick={() => void openResource(presented.id)}>详情</Button>
                            <Button
                              type="link"
                              aria-label="删除"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => void armDelete(presented.id, "list")}
                              disabled={libraryState.busy}
                            >
                              删除
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}
            </section>
          </div>
          )}
        </Content>
      </Layout>
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
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#0f6b5c",
          colorInfo: "#0f6b5c",
          colorText: "#26383d",
          colorTextSecondary: "#52676d",
          colorBgLayout: "#f4f7f8",
          colorBorder: "#cedadd",
          borderRadius: 8,
          fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
        },
        components: {
          Layout: { siderBg: "#fbfdfd", headerBg: "#fbfdfd" },
          Menu: { itemSelectedColor: "#0f6b5c", itemSelectedBg: "#e5f2ef" },
        },
      }}
    >
      <AntDesignApp>
        <LearningLibrary runtime={runtime} />
      </AntDesignApp>
    </ConfigProvider>
  );
}
