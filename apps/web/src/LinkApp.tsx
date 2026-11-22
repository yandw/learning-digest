import { useEffect, useState } from "react";
import { Alert, App as AntDesignApp, Button, ConfigProvider, Form, Input, Spin } from "antd";
import zhCN from "antd/es/locale/zh_CN";
import { libraryTheme } from "./AuthLayout";

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
    <main className="link-shell">
      <header className="link-topbar">
        <span className="wordmark">
          <i aria-hidden="true" />
          Learning Digest
        </span>
      </header>
      <div className="link-main">
        <section className="link-card" aria-labelledby="linkTitle">
          <p className="link-eyebrow">{completed ? "CONNECTED" : "BROWSER EXTENSION"}</p>
          <h1 id="linkTitle">{completed ? "浏览器插件已关联" : "关联浏览器插件"}</h1>
          <p className="link-lede">
            {completed
              ? "现在可以从插件收藏网页、开始学习，并同步课程笔记。"
              : "使用当前账号授权该浏览器，将收藏、学习进度和课程笔记同步到学习库。"}
          </p>
          {!ready ? (
            <div className="startup-loading" aria-label="正在检查登录状态"><Spin /></div>
          ) : completed ? (
            <div className="link-actions">
              <Button type="primary" href="/" autoInsertSpace={false}>
                打开学习库
              </Button>
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
                  <Button type="primary" htmlType="submit" loading={state.login.busy} block>
                    登录并继续关联
                  </Button>
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
                  <div className="link-actions">
                    <Button
                      type="primary"
                      loading={state.state === "issuing"}
                      onClick={() => void confirmLink()}
                      autoInsertSpace={false}
                    >
                      确认关联
                    </Button>
                    <Button onClick={() => window.history.back()} autoInsertSpace={false}>
                      取消
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export default function LinkApp({ runtime: providedRuntime }: { runtime?: LinkRuntime }) {
  if (!providedRuntime) {
    throw new Error("LinkApp requires a runtime");
  }
  return (
    <ConfigProvider locale={zhCN} theme={libraryTheme}>
      <AntDesignApp><LinkFlow runtime={providedRuntime} /></AntDesignApp>
    </ConfigProvider>
  );
}
