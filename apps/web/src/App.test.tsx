import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginFlow } from "../public/js/login-flow.js";
import { createLibraryFlow } from "../public/js/library.js";
import { createCredentialStore } from "../public/js/credentials.js";
import App from "./App";

const RESOURCE = {
  resource: {
    id: "res_1",
    title: "注意力机制详解",
    kind: "video",
    createdAt: "2026-11-10T08:00:00Z",
  },
  sources: [
    {
      id: "src_1",
      resourceId: "res_1",
      kind: "video",
      url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
      platformId: "bilibili",
      durationMs: 500000,
      progress: { positionMs: 250000, revision: 1 },
    },
  ],
};

function makeRuntime({ authenticated = false, collection = [RESOURCE] } = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const credentials = createCredentialStore({ storage });
  if (authenticated) {
    credentials.set({ token: "web-token", email: "learner@example.com" });
  }
  const resources = structuredClone(collection);
  const calls = {
    create: [] as unknown[],
    delete: [] as string[],
  };
  const api = {
    requestCode: async () => ({ ok: true, status: 200, data: {} }),
    verify: async () => ({
      ok: true,
      status: 200,
      data: {
        account: { id: "acc_1", email: "learner@example.com" },
        credential: { token: "web-token", credentialGroupId: "grp_1" },
      },
    }),
    logout: async () => ({ ok: true, status: 200, data: {} }),
    listNotes: vi.fn(async () => ({ ok: true, data: { notes: [{
      id: "note_1", resourceId: "res_1", sourceId: "src_1", positionMs: 75000, kind: "excerpt", text: "从侧面照过来",
    }] } })),
    listResources: async () => ({
      ok: true,
      status: 200,
      data: { resources: [...resources] },
    }),
    createResource: async (body: unknown) => {
      calls.create.push(body);
      return { ok: true, status: 201, data: structuredClone(RESOURCE) };
    },
    deleteResource: async (id: string) => {
      calls.delete.push(id);
      resources.splice(0, resources.length);
      return { ok: true, status: 200, data: {} };
    },
  };
  return {
    api,
    credentials,
    login: createLoginFlow({ api, credentials }),
    library: createLibraryFlow({ api, identity: { extractVideoIdentity: () => null } }),
    openDetail: vi.fn(),
    calls,
  };
}

describe("React learning library", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("completes invited-email login, restores the list, and logs out", async () => {
    const runtime = makeRuntime();
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "登录学习库" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("邮箱"), "LEARNER@example.com");
    await user.click(screen.getByRole("button", { name: "获取验证码" }));
    await user.type(await screen.findByLabelText("验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "登录学习库", }));

    expect(await screen.findByRole("tab", { name: /学习资料/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "注意力机制详解" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "学习进度" })).toHaveAttribute("value", "250000");
    expect(screen.getByText("learner@example.com")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("heading", { name: "登录学习库" })).toBeInTheDocument();
    expect(runtime.credentials.get()).toBeNull();
  });

  it("restores a stored credential and opens the compatibility detail entry", async () => {
    const runtime = makeRuntime({ authenticated: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("link", { name: "注意力机制详解" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "注意力机制详解" }));
    expect(runtime.openDetail).toHaveBeenCalledWith("res_1");
  });

  it("collects a pasted URL through the existing flow", async () => {
    const runtime = makeRuntime({ authenticated: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("link", { name: "注意力机制详解" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收藏资料" }));
    await user.click(await screen.findByLabelText("网页链接"));
    await user.paste("https://example.com/course");
    await user.click(screen.getByLabelText("标题（可选）"));
    await user.paste("新课程");
    await user.click(screen.getByRole("button", { name: "收藏", }));

    await waitFor(() => expect(runtime.calls.create).toHaveLength(1));
    expect(runtime.calls.create[0]).toEqual({
      url: "https://example.com/course",
      title: "新课程",
    });
    expect(await screen.findByText("已收藏", { exact: true })).toBeInTheDocument();
  });

  it("keeps two-click quick deletion working after React re-renders the row", async () => {
    const runtime = makeRuntime({ authenticated: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("link", { name: "注意力机制详解" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /资料操作/ }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    await user.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(runtime.calls.delete).toEqual(["res_1"]));
    expect(screen.queryByRole("link", { name: "注意力机制详解" })).not.toBeInTheDocument();
    expect(await screen.findByText("收藏的网页和课程会出现在这里。")).toBeInTheDocument();
  });

  it("confirms deletion after the underlying two-click arm has expired", async () => {
    const runtime = makeRuntime({ authenticated: true });
    const user = userEvent.setup();
    render(<App runtime={runtime} />);

    expect(await screen.findByRole("link", { name: "注意力机制详解" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /资料操作/ }));
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    runtime.library.disarmDelete();
    await user.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(runtime.calls.delete).toEqual(["res_1"]));
    expect(await screen.findByText("收藏的网页和课程会出现在这里。")).toBeInTheDocument();
  });
});

it("searches past the first batch, restores its count, and opens a note at its source position", async () => {
  const extra = Array.from({ length: 7 }, (_, i) => ({
    resource: { ...RESOURCE.resource, id: `resource-${i}`, title: `第 ${i + 1} 条资料` },
    sources: [],
  }));
  const runtime = makeRuntime({ authenticated: true, collection: [RESOURCE, ...extra] });
  const user = userEvent.setup();
  render(<App runtime={runtime} />);

  const resourceSearch = await screen.findByRole("textbox", { name: "搜索资料标题" });
  expect(screen.getByText("已显示 6 / 8 项资料")).toBeInTheDocument();
  await user.type(resourceSearch, "第 7 条");
  expect(screen.getByRole("link", { name: "第 7 条资料" })).toBeInTheDocument();
  await user.clear(resourceSearch);
  expect(screen.getByText("已显示 6 / 8 项资料")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "加载更多" }));
  expect(screen.getByText("已显示 8 / 8 项资料")).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: /笔记汇总/ }));
  const noteSearch = screen.getByRole("textbox", { name: "搜索笔记正文或课程名" });
  await user.type(noteSearch, "注意力");
  expect(await screen.findByText("从侧面照过来")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "回到 1:15 ↗" })).toHaveAttribute("href", expect.stringContaining("p=2&t=75"));
  expect(screen.getByRole("link", { name: "继续学习 →" })).toHaveAttribute("href", expect.stringContaining("p=2&t=250"));
});
