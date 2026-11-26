import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createLoginFlow } from "../public/js/login-flow.js";
import { createLibraryFlow } from "../public/js/library.js";
import { createCredentialStore } from "../public/js/credentials.js";
import App from "./App";

const RESOURCE = {
  id: "res_1",
  title: "注意力机制详解",
  kind: "video",
  createdAt: "2026-11-10T08:00:00Z",
};
const SOURCES = [
  {
    id: "src_1",
    resourceId: "res_1",
    kind: "video",
    url: "https://www.bilibili.com/video/BV1ab411L78c?p=2",
    platformId: "bilibili",
    progress: { positionMs: 250000, revision: 1 },
  },
];
const SUMMARY = {
  id: "sum_1",
  generatedAt: "2026-11-10T09:00:00Z",
  content: "## 核心概念\n\n**注意力**让模型选择相关信息。",
  citations: [
    {
      quote: "注意力会选择重要的信息",
      segmentRef: { sessionId: "ses_1", startMs: 65000, endMs: 70000 },
    },
  ],
};

function makeRuntime({ partialFailure = false, organizingTranscript = false, summary = SUMMARY } = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const credentials = createCredentialStore({ storage });
  credentials.set({ token: "web-token", email: "learner@example.com" });
  const resources = [{ resource: { ...RESOURCE }, sources: structuredClone(SOURCES) }];
  const detail = {
    resource: { ...RESOURCE },
    sources: structuredClone(SOURCES),
    notes: [
      {
        id: "note_1",
        sourceId: "src_1",
        positionMs: 65000,
        text: "注意 Q、K、V 的角色。",
      },
    ],
    sessions: [
      {
        id: "ses_1",
        sourceId: "src_1",
        status: "finished",
        origin: "captions",
        startedAt: "2026-11-10T08:30:00Z",
        transcript: { recordCount: 1, gapCount: 0, failedCount: 0 },
      },
    ],
  };
  const calls = {
    retitle: [] as Array<{ id: string; title: string }>,
    generate: [] as string[],
    delete: [] as string[],
  };
  let summaries = partialFailure ? [] : [{ ...SUMMARY, content: undefined, citations: undefined, citationCount: 1 }];
  let summaryReadsFail = partialFailure;
  let transcriptReads = 0;
  const api = {
    listResources: async () => ({ ok: true, status: 200, data: { resources: [...resources] } }),
    getResourceDetail: async () => ({ ok: true, status: 200, data: structuredClone(detail) }),
    getSessionTranscript: async () => partialFailure
      ? { ok: false, status: 500, data: { error: { message: "逐字稿服务暂不可用" } } }
      : {
          ok: true,
          status: 200,
          data: {
            sourceId: "src_1",
            sessionId: "ses_1",
            sessionStatus: "finished",
            records: [{ startMs: 65000, endMs: 70000, text: "注意力会选择重要的信息" }],
            gaps: [],
            pending: [],
            failed: [],
            ...(organizingTranscript && {
              organized: ++transcriptReads === 1 ? { status: "processing" } : {
                status: "ready",
                paragraphs: [{ sentences: [{ text: "注意力会选择重要的信息。", startMs: 65000, endMs: 70000 }] }],
              },
            }),
          },
        },
    listSummaries: async () => summaryReadsFail
      ? { ok: false, status: 500, data: { error: { message: "总结历史暂不可用" } } }
      : { ok: true, status: 200, data: { summaries: [...summaries] } },
    getSummary: async () => ({ ok: true, status: 200, data: { summary: structuredClone(summary) } }),
    updateResourceTitle: async (id: string, title: string) => {
      calls.retitle.push({ id, title });
      detail.resource.title = title;
      resources[0].resource.title = title;
      return { ok: true, status: 200, data: { resource: { ...detail.resource } } };
    },
    generateSummary: async (id: string) => {
      calls.generate.push(id);
      summaryReadsFail = false;
      summaries = [{ ...SUMMARY, content: undefined, citations: undefined, citationCount: 1 }];
      return { ok: true, status: 201, data: { summary: structuredClone(SUMMARY) } };
    },
    deleteResource: async (id: string) => {
      calls.delete.push(id);
      resources.splice(0, resources.length);
      return { ok: true, status: 200, data: { deleted: true } };
    },
  };
  const library = createLibraryFlow({ api, identity: { extractVideoIdentity: () => null } });
  return {
    credentials,
    login: createLoginFlow({ api, credentials }),
    library,
    openDetail: vi.fn((id: string) => library.openDetail(id)),
    calls,
  };
}

async function openDetail(runtime: ReturnType<typeof makeRuntime>) {
  const user = userEvent.setup();
  render(<App runtime={runtime} />);
  await user.click(await screen.findByRole("link", { name: RESOURCE.title }));
  return user;
}

describe("React resource learning workbench", () => {
  it("opens sources, notes, transcripts, summary citations and source jumps", async () => {
    const runtime = makeRuntime();
    const user = await openDetail(runtime);

    expect(await screen.findByText("注意 Q、K、V 的角色。")).toBeInTheDocument();
    const transcriptToggle = screen.getByRole("button", { name: "展开逐字稿" });
    expect(transcriptToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("注意力会选择重要的信息", { selector: ".transcript-text" })).not.toBeInTheDocument();
    await user.click(transcriptToggle);
    expect(transcriptToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("注意力会选择重要的信息", { selector: ".transcript-text" })).toBeInTheDocument();
    expect(screen.getByText("核心概念")).toBeInTheDocument();
    expect(screen.getByText("注意力", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("「注意力会选择重要的信息」")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).not.toBeInTheDocument();
    expect(screen.getByText("上次学到 4:10", { selector: ".detail-sources *" })).toBeInTheDocument();
    const jumps = screen.getAllByTitle("回到原视频的这个位置");
    expect(jumps[0]).toHaveAttribute("href", expect.stringContaining("t=65"));
    expect(runtime.openDetail).toHaveBeenCalledWith("res_1");
  });

  it("updates an open transcript when organization completes", async () => {
    const runtime = makeRuntime({ organizingTranscript: true });
    const user = await openDetail(runtime);
    await user.click(await screen.findByRole("button", { name: "展开逐字稿" }));
    expect(screen.getByText("注意力会选择重要的信息", { selector: ".transcript-text" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("正在整理逐字稿");
    const sentence = await screen.findByText("注意力会选择重要的信息。", { selector: ".transcript-text" }, { timeout: 3000 });
    expect(within(sentence.closest("li")!).getByRole("link", { name: "1:05" }))
      .toHaveAttribute("href", expect.stringContaining("t=65"));
  });

  it("shows a directed course flowchart with per-connection source jumps and a text fallback", async () => {
    const quote = "若维数大则缩放点积，否则直接使用";
    const modelText = "<img src=x onerror=alert(1)>";
    const summary = {
      ...SUMMARY,
      content: "## 并列建议\n\n- 记录维数\n- 保存结果",
      flowchart: {
        title: "点积处理",
        nodes: [
          { id: "check", label: "检查维数" },
          { id: "scale", label: "缩放点积" },
          { id: "direct", label: modelText },
        ],
        edges: [
          {
            from: "check",
            to: "scale",
            label: "维数大",
            citation: { quote, segmentRef: { sessionId: "ses_1", startMs: 65000, endMs: 70000 } },
          },
          {
            from: "check",
            to: "direct",
            label: "其他情况",
            citation: { quote, segmentRef: { sessionId: "ses_missing", startMs: 70000, endMs: 75000 } },
          },
        ],
      },
    };
    await openDetail(makeRuntime({ summary }));

    const chart = await screen.findByRole("figure", { name: "点积处理" });
    const graph = within(chart);
    expect(graph.getAllByText("检查维数")).toHaveLength(1);
    expect(graph.getByText("维数大")).toBeInTheDocument();
    expect(graph.getByText("缩放点积")).toBeInTheDocument();
    expect(graph.getByText("其他情况")).toBeInTheDocument();
    expect(graph.getByText(modelText)).toBeInTheDocument();
    expect(graph.queryByRole("img")).not.toBeInTheDocument();
    expect(graph.getByRole("link", { name: "1:05–1:10" })).toHaveAttribute("href", expect.stringContaining("t=65"));
    expect(graph.getByText("1:10–1:15")).toBeInTheDocument();
    expect(graph.queryByRole("link", { name: "1:10–1:15" })).not.toBeInTheDocument();
    expect(graph.getAllByText(`「${quote}」`)).toHaveLength(2);
    expect(screen.getByText("记录维数").closest("li")).toBeInTheDocument();
    expect(screen.getByText("保存结果").closest("li")).toBeInTheDocument();
  });

  it("edits the resource title through the existing flow", async () => {
    const runtime = makeRuntime();
    const user = await openDetail(runtime);

    await user.click(await screen.findByRole("button", { name: "编辑标题" }));
    const input = screen.getByLabelText("资料标题");
    await user.clear(input);
    await user.type(input, "注意力机制：完整笔记");
    await user.click(screen.getByRole("button", { name: "保存标题" }));

    await waitFor(() => expect(runtime.calls.retitle).toEqual([
      { id: "res_1", title: "注意力机制：完整笔记" },
    ]));
    expect(await screen.findByRole("heading", { name: "注意力机制：完整笔记" })).toBeInTheDocument();
  });

  it("generates and displays a new course summary", async () => {
    const runtime = makeRuntime({ partialFailure: true });
    const user = await openDetail(runtime);

    await user.click(await screen.findByRole("button", { name: "生成总结" }));

    await waitFor(() => expect(runtime.calls.generate).toEqual(["res_1"]));
    expect(await screen.findByText("核心概念")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第 1 次/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the detail usable when transcript and summary reads fail", async () => {
    const runtime = makeRuntime({ partialFailure: true });
    const user = await openDetail(runtime);

    expect(await screen.findByText("注意 Q、K、V 的角色。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开逐字稿" }));
    expect(screen.getByText("逐字稿加载失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByText("总结历史暂不可用")).toBeInTheDocument();
  });

  it("deletes from the detail and returns to the refreshed list", async () => {
    const runtime = makeRuntime();
    const user = await openDetail(runtime);

    await user.click(await screen.findByRole("button", { name: "删除资料" }));
    await user.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(runtime.calls.delete).toEqual(["res_1"]));
    expect(await screen.findByRole("tab", { name: /学习资料/ })).toBeInTheDocument();
    expect(screen.getByText("收藏的网页和课程会出现在这里。")).toBeInTheDocument();
  });
});
