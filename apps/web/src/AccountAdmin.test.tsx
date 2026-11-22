import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLoginFlow } from "../public/js/login-flow.js";
import { createLibraryFlow } from "../public/js/library.js";
import { createCredentialStore } from "../public/js/credentials.js";
import { createAdminFlow } from "../public/js/admin.js";
import App from "./App";
import { createLearningRuntime } from "./runtime";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function makeRuntime({ admin = false, adminDenied = false } = {}) {
  const values = new Map<string, string>();
  const credentials = createCredentialStore({
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  credentials.set({ token: "web-token", email: "learner@example.com" });
  const calls = { update: [] as Array<{ id: string; patch: unknown }> };
  const api = {
    me: async () => ({
      ok: true,
      status: 200,
      data: { account: { email: "learner@example.com", isAdmin: admin } },
    }),
    getUsage: async () => ({
      ok: true,
      status: 200,
      data: {
        audioSeconds: 150,
        summaryCount: 3,
        summaryInputChars: 4200,
        updatedAt: "2026-11-10T09:00:00Z",
      },
    }),
    getAdminSiteCapabilities: async () => adminDenied
      ? { ok: false, status: 404, data: { error: { message: "接口不存在或无权访问" } } }
      : {
          ok: true,
          status: 200,
          data: {
            capabilities: [
              { platformId: "bilibili", captions: true, asr: true, enabled: true },
            ],
          },
        },
    updateAdminSiteCapability: async (id: string, patch: unknown) => {
      calls.update.push({ id, patch });
      return {
        ok: true,
        status: 200,
        data: { capability: { platformId: id, captions: false, asr: true, enabled: true } },
      };
    },
    listResources: async () => ({ ok: true, status: 200, data: { resources: [] } }),
  };
  return {
    credentials,
    login: createLoginFlow({ api, credentials }),
    library: createLibraryFlow({ api, identity: { extractVideoIdentity: () => null } }),
    admin: createAdminFlow({ api }),
    api,
    openDetail: vi.fn(),
    calls,
  };
}

describe("React account and administration", () => {
  it("loads current usage and hides site administration from non-admins", async () => {
    const runtime = makeRuntime();
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "用量" }));
    expect(await screen.findByText("2:30")).toBeInTheDocument();
    expect(screen.getByText("3 次")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "站点管理" })).not.toBeInTheDocument();
  });

  it("saves only the changed capability keys for one administrator row", async () => {
    const runtime = makeRuntime({ admin: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "站点管理" }));
    const captions = await screen.findByRole("switch", { name: "bilibili 字幕" });
    await user.click(captions);
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(runtime.calls.update).toEqual([
      { id: "bilibili", patch: { captions: false } },
    ]));
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("presents the admin 404 envelope verbatim without exposing credentials", async () => {
    const runtime = makeRuntime({ admin: true, adminDenied: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "站点管理" }));
    expect(await screen.findByText("接口不存在或无权访问")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("returns to login and clears the credential when usage answers 401", async () => {
    window.localStorage.setItem(
      "learning-digest.web.credentials",
      JSON.stringify({ token: "expired-token", email: "learner@example.com" }),
    );
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path === "/v1/usage"
        ? { error: { message: "登录已失效" } }
        : path === "/v1/me"
          ? { account: { email: "learner@example.com", isAdmin: false } }
          : { resources: [] };
      return new Response(JSON.stringify(body), {
        status: path === "/v1/usage" ? 401 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const runtime = createLearningRuntime();
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    await user.click(await screen.findByRole("button", { name: "用量" }));

    expect(await screen.findByRole("heading", { name: "登录学习库" })).toBeInTheDocument();
    expect(runtime.credentials.get()).toBeNull();
  });
});
