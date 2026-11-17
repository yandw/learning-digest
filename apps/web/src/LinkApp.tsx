import { useEffect, useState } from "react";
import { Alert, App as AntDesignApp, Button, ConfigProvider, Form, Input, Space, Spin } from "antd";
import zhCN from "antd/es/locale/zh_CN";

export type LinkRuntime = {
  link: any;
  subscribeSessionExpired?: (listener: () => void) => () => void;
};

function LinkFlow({ runtime }: { runtime: LinkRuntime }) {
  const [state, setState] = useState(runtime.link.getState());
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [existingCode, setExistingCode] = useState<string | null>(null);
  const flow = runtime.link;
  const refresh = () => setState(flow.getState());

  useEffect(() => {
    const codeFromUrl = new URLSearchParams(window.location.search).get("link");
    if (codeFromUrl) {
      setExistingCode(codeFromUrl);
      setReady(true);
      return;
    }
    let active = true;
    void flow.start().then(() => {
      if (!active) return;
      refresh();
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [flow]);

  useEffect(() => runtime.subscribeSessionExpired?.(refresh), [runtime]);

  const submitEmail = async () => {
    const pending = flow.submitEmail(email);
    refresh();
    await pending;
    setCode("");
    refresh();
  };

  const submitCode = async () => {
    const pending = flow.submitCode(code);
    refresh();
    await pending;
    refresh();
  };

  const confirmLink = async () => {
    const pending = flow.confirmLink();
    refresh();
    const result = await pending;
    if (result.ok) {
      window.history.replaceState({}, "", `/link.html?link=${encodeURIComponent(result.linkCode)}`);
    }
    refresh();
  };

  const completed = Boolean(existingCode) || state.state === "issued";
  const error = state.error || state.login.error;

  return (
    <main className="login-shell">
      <section className="login-panel link-panel" aria-labelledby="linkTitle">
        <div className="login-brand">
          <div className="brand" style={{ padding: 0, minHeight: 0 }}>
            <span className="brand-mark" aria-hidden="true">L</span>
            <span>Learning Digest</span>
          </div>
        </div>
        <h1 id="linkTitle">{completed && existingCode ? "已发起关联" : "关联浏览器插件"}</h1>
        <p className="login-lede">
          把浏览器插件关联到当前账号，学习记录会进入这个学习库，并可与网页端一起退出登录。
        </p>
        {!ready ? (
          <div className="startup-loading" aria-label="正在检查登录状态"><Spin /></div>
        ) : completed ? (
          <div className="link-complete" role="status">
            <Alert type="success" showIcon title="关联码已生成。请回到浏览器插件，连接会自动完成。" />
            <p>本页面可以关闭。</p>
          </div>
        ) : (
          <>
            {state.login.notice && state.state === "login-code" && (
              <Alert className="login-notice" type="success" showIcon title={state.login.notice} />
            )}
            {error && <Alert className="login-notice" type="error" showIcon title={error} />}
            {state.state === "checking" || state.state === "issuing" ? (
              <div className="startup-loading"><Spin /> 正在处理，请稍候…</div>
            ) : state.state === "login-code" ? (
              <Form layout="vertical" onFinish={() => void submitCode()} requiredMark={false}>
                <Form.Item label="验证码" required>
                  <Input
                    aria-label="验证码"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    size="large"
                    autoFocus
                  />
                </Form.Item>
                <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                  <Button type="primary" htmlType="submit" loading={state.login.busy} block>
                    登录并继续关联
                  </Button>
                  <Button
                    type="link"
                    onClick={() => {
                      flow.backToEmail();
                      setCode("");
                      refresh();
                    }}
                    block
                  >
                    更换邮箱
                  </Button>
                </Space>
              </Form>
            ) : state.state === "login-email" ? (
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
                <Button type="primary" htmlType="submit" loading={state.login.busy} block>
                  获取验证码
                </Button>
              </Form>
            ) : (
              <>
                <p>确认后，插件会获得本账号的关联凭据，与当前网页会话属于同一账号。</p>
                <Button
                  type="primary"
                  loading={state.state === "issuing"}
                  onClick={() => void confirmLink()}
                  block
                >
                  确认关联
                </Button>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default function LinkApp({ runtime: providedRuntime }: { runtime?: LinkRuntime }) {
  if (!providedRuntime) {
    throw new Error("LinkApp requires a runtime");
  }
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#0f6b5c",
          colorInfo: "#0f6b5c",
          colorText: "#26383d",
          colorBgLayout: "#f4f7f8",
          borderRadius: 8,
          fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
        },
      }}
    >
      <AntDesignApp><LinkFlow runtime={providedRuntime} /></AntDesignApp>
    </ConfigProvider>
  );
}
