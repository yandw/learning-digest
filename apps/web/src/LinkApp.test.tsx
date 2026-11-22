import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../public/js/credentials.js";
import { createLinkFlow } from "../public/js/link-flow.js";
import LinkApp from "./LinkApp";

function makeRuntime({ authenticated = true } = {}) {
  const values = new Map<string, string>();
  const credentials = createCredentialStore({
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  if (authenticated) {
    credentials.set({ token: "web-token", email: "learner@example.com" });
  }
  const api = {
    me: async () => ({ ok: true, status: 200, data: { account: { email: "learner@example.com" } } }),
    requestCode: async () => ({ ok: true, status: 200, data: {} }),
    verify: async () => ({
      ok: true,
      status: 200,
      data: {
        account: { email: "learner@example.com" },
        credential: { token: "new-token", credentialGroupId: "grp_1" },
      },
    }),
    createLinkRequest: async () => ({ ok: true, status: 201, data: { linkCode: "one-time-code" } }),
  };
  return { link: createLinkFlow({ api, credentials }), credentials };
}

describe("React extension authorization", () => {
  it("confirms a live account and leaves the one-time code in the final URL", async () => {
    const runtime = makeRuntime();
    const user = userEvent.setup();
    render(<LinkApp runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "确认关联" }));

    expect(await screen.findByRole("heading", { name: "浏览器插件已关联" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "打开学习库" })).toBeInTheDocument();
    expect(window.location.search).toBe("?link=one-time-code");
    expect(screen.queryByRole("button", { name: "确认关联" })).not.toBeInTheDocument();
  });

  it("logs in first and then returns to the authorization confirmation", async () => {
    const runtime = makeRuntime({ authenticated: false });
    const user = userEvent.setup();
    render(<LinkApp runtime={runtime} />);

    await user.type(await screen.findByLabelText("邮箱"), "learner@example.com");
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "登录并继续关联" }));

    expect(await screen.findByRole("button", { name: "确认关联" })).toBeInTheDocument();
  });

  it("shows the completion state directly for an existing success URL", async () => {
    window.history.replaceState({}, "", "/link.html?link=already-issued");
    const runtime = makeRuntime();
    render(<LinkApp runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "浏览器插件已关联" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认关联" })).not.toBeInTheDocument();
  });
});
