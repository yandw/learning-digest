import { useState } from "react";
import { Alert, Button, Empty, Input, Space, Spin, Tag, Typography } from "antd";
import { ArrowLeftOutlined, DeleteOutlined, DownOutlined, EditOutlined, LinkOutlined, RightOutlined } from "@ant-design/icons";
import {
  buildNoteJumpUrl,
  formatDateTime,
  formatPosition,
  mergeTranscriptViews,
  noteKindLabel,
  presentDetail,
  presentNote,
  presentSummary,
  presentSummariesList,
  presentTranscript,
  sessionOriginLabel,
} from "../public/js/library.js";

type SessionDigest = {
  overview: string[];
  topics: { startMs: number; title: string; summary?: string; bullets?: string[] }[];
  categories: { title: string; points: string[] }[];
  quotes: { startMs: number; text: string }[];
  todos: string[];
};

type DigestRead = { digest: SessionDigest | null; error: string | null };

type ResourceDetailProps = {
  state: any;
  onBack: () => void;
  onRetitle: (title: string) => Promise<boolean>;
  onGenerate: () => Promise<void>;
  onShowSummary: (id: string) => Promise<void>;
  onReadSessionDigest: (id: string) => Promise<DigestRead>;
  onDelete: () => void;
};

function SourceJump({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) {
    return <span className="transcript-stamp">{children}</span>;
  }
  return (
    <a
      className="note-stamp"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="回到原视频的这个位置"
    >
      {children}
    </a>
  );
}

function MarkdownRuns({ runs }: { runs: Array<{ text: string; bold: boolean }> }) {
  return runs.map((run, index) => run.bold
    ? <strong key={index}>{run.text}</strong>
    : <span key={index}>{run.text}</span>);
}

function SummaryBlocks({ blocks }: { blocks: any[] }) {
  return blocks.map((block, index) => {
    if (block.kind === "ul") {
      return (
        <ul className="summary-list" key={index}>
          {block.items.map((runs: any, itemIndex: number) => (
            <li key={itemIndex}><MarkdownRuns runs={runs} /></li>
          ))}
        </ul>
      );
    }
    if (["h1", "h2", "h3"].includes(block.kind)) {
      const level = { h1: 3, h2: 4, h3: 5 }[block.kind as "h1" | "h2" | "h3"] as 3 | 4 | 5;
      return <Typography.Title level={level} key={index}><MarkdownRuns runs={block.runs} /></Typography.Title>;
    }
    return <p className="summary-paragraph" key={index}><MarkdownRuns runs={block.runs} /></p>;
  });
}

function CollapsibleSection({
  id,
  title,
  count,
  subtitle,
  actions,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  count?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="detail-panel" aria-labelledby={`${id}Heading`}>
      <div className={`detail-section-heading${open ? "" : " section-collapsed"}`}>
        <div className="detail-section-title">
          <Button
            type="text"
            size="small"
            className="section-toggle"
            aria-expanded={open}
            aria-controls={`${id}Body`}
            aria-label={open ? `收起${title}` : `展开${title}`}
            icon={open ? <DownOutlined /> : <RightOutlined />}
            onClick={() => setOpen((value) => !value)}
          />
          <div className="detail-section-lead">
            <h2 id={`${id}Heading`}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {count && <span className="list-count">{count}</span>}
        </div>
        {actions}
      </div>
      {open && <div id={`${id}Body`}>{children}</div>}
    </section>
  );
}

function DigestPoints({ points }: { points: string[] }) {
  return <ul className="summary-list">{points.map((point, index) => <li key={index}>{point}</li>)}</ul>;
}

function SessionDigestItem({ startedAt, onRead, jumpTo }: {
  startedAt: string;
  onRead: () => Promise<DigestRead>;
  jumpTo: (positionMs: number) => string | null;
}) {
  const [result, setResult] = useState<DigestRead>();
  const [loading, setLoading] = useState(false);
  const read = async () => {
    setLoading(true);
    setResult(await onRead());
    setLoading(false);
  };
  const digest = result?.digest;
  return (
    <article className="summary-content">
      <h3>{formatDateTime(startedAt)} 的学习</h3>
      {(!result || result.error) && (
        <Button loading={loading} onClick={() => void read()}>
          {result?.error ? "重试加载学习纪要" : "查看学习纪要"}
        </Button>
      )}
      {result?.error && <Alert type="warning" showIcon title={result.error} />}
      {result && !result.error && !digest && <p>本次学习还没有纪要</p>}
      {digest && (
        <>
          {digest.overview.length > 0 && <DigestPoints points={digest.overview} />}
          {digest.topics.map((topic, index) => (
            <div key={index}>
              <h4>{topic.title} <SourceJump href={jumpTo(topic.startMs)}>{formatPosition(topic.startMs)}</SourceJump></h4>
              {topic.bullets?.length ? <DigestPoints points={topic.bullets} /> : <p>{topic.summary}</p>}
            </div>
          ))}
          {digest.categories.map((category, index) => (
            <div key={index}>
              <h4>{category.title}</h4>
              <DigestPoints points={category.points} />
            </div>
          ))}
          {digest.quotes.map((quote, index) => (
            <blockquote key={index}>
              <SourceJump href={jumpTo(quote.startMs)}>{formatPosition(quote.startMs)}</SourceJump> {quote.text}
            </blockquote>
          ))}
          {digest.todos.length > 0 && <><h4>待办</h4><DigestPoints points={digest.todos} /></>}
        </>
      )}
    </article>
  );
}

export default function ResourceDetail({
  state,
  onBack,
  onRetitle,
  onGenerate,
  onShowSummary,
  onReadSessionDigest,
  onDelete,
}: ResourceDetailProps) {
  const detail = state.detail;
  const presented = presentDetail(detail);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(presented.title);
  const sources = detail.sources || [];
  const notes = detail.notes || [];
  const sessions = detail.sessions || [];
  const finishedSessions = sessions.filter((session: { status: string }) => session.status === "finished");
  const summaries = presentSummariesList(state.summaries);
  const activeSummary = state.activeSummaryId
    ? state.summaryDetails[state.activeSummaryId]
    : undefined;
  const summary = presentSummary(activeSummary, sessions, sources);

  // 同一视频多段学习的逐字稿合并成一份展示（owner decision 2026-11-17：
  // 一份资料只有一份逐字稿，重复副本会让课程总结输入重复文本）。
  const sessionViews = sessions.map((session: any) => (detail.transcripts || {})[session.id]);
  const mergedView = mergeTranscriptViews(sessionViews);
  const entries = presentTranscript(mergedView, sources);

  const saveTitle = async () => {
    if (await onRetitle(title)) {
      setEditingTitle(false);
    }
  };

  return (
    <div className="detail-workbench">
      <Button
        type="link"
        className="back-button"
        icon={<ArrowLeftOutlined />}
        onClick={onBack}
      >
        返回学习列表
      </Button>

      <header className="detail-heading">
        {editingTitle ? (
          <div className="title-editor">
            <Input
              aria-label="资料标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onPressEnter={() => void saveTitle()}
              autoFocus
            />
            <Button type="primary" loading={state.busy} onClick={() => void saveTitle()}>保存标题</Button>
            <Button
              disabled={state.busy}
              onClick={() => {
                setTitle(presented.title);
                setEditingTitle(false);
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <>
            <h1>{presented.title}</h1>
            <Space className="detail-title-actions" wrap>
              {presented.sources[0]?.url && (
                <Button type="primary" href={presented.sources[0].url} target="_blank" rel="noreferrer">回到原平台</Button>
              )}
              <Button aria-label="编辑标题" icon={<EditOutlined aria-hidden="true" />} onClick={() => setEditingTitle(true)}>
                编辑标题
              </Button>
            </Space>
          </>
        )}
      </header>

      {(state.notice || state.error) && (
        <div className="feedback-stack">
          {state.notice && <Alert type="success" showIcon title={state.notice} />}
          {state.error && <Alert type="error" showIcon title={state.error} />}
        </div>
      )}

      <CollapsibleSection id="source" title="资料来源">
        <ul className="detail-sources">
          {presented.sources.map((source: any) => (
            <li key={source.id}>
              <a className="source-link" href={source.url} target="_blank" rel="noopener noreferrer">
                <LinkOutlined /> {source.url}
              </a>
              <Space size={8} wrap className="resource-meta">
                <Tag>{source.kindLabel}</Tag>
                {source.platformLabel && <Tag color="cyan">{source.platformLabel}</Tag>}
                {source.podcastTitle && <Typography.Text>{source.podcastTitle}</Typography.Text>}
                {source.durationText && <Typography.Text type="secondary">{source.durationText}</Typography.Text>}
                {source.progressText && <Typography.Text type="secondary">{source.progressText}</Typography.Text>}
              </Space>
              {source.showNotes && (
                <div className="episode-show-notes">
                  <Typography.Text strong>节目简介</Typography.Text>
                  <p>{source.showNotes}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleSection>

      <CollapsibleSection
        id="notes"
        title="学习笔记"
        count={`${presented.notesCount} 条`}
      >
        {notes.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有学习笔记。" />
        ) : (
          <ul className="detail-notes">
            {notes.map((note: any) => {
              const item = presentNote(note);
              return (
                <li key={item.id}>
                  <div className="detail-note-meta">
                    <span>{noteKindLabel(note)}</span>
                    {item.stamp && <SourceJump href={buildNoteJumpUrl(note, sources)}>{item.stamp}</SourceJump>}
                  </div>
                  <p className="note-text">{item.text}</p>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        id="summary"
        title="课程总结"
        subtitle="总结与原文引用会保留在历次生成记录中。"
        actions={(
          <Button type="primary" loading={state.generating} disabled={state.busy} onClick={() => void onGenerate()}>
            {state.generating ? "生成中…" : "生成总结"}
          </Button>
        )}
      >
        {state.summariesError && <Alert type="error" showIcon title={state.summariesError} />}
        {summaries.length > 0 && (
          <div className="summary-history" aria-label="历次总结">
            {summaries.map((item: any) => (
              <Button
                key={item.id}
                size="small"
                type={item.id === state.activeSummaryId ? "primary" : "default"}
                aria-pressed={item.id === state.activeSummaryId}
                onClick={() => void onShowSummary(item.id)}
              >
                第 {item.ordinal} 次 · {item.generatedAtText} · {item.citationCount} 条引用
              </Button>
            ))}
          </div>
        )}
        {summaries.length === 0 && !state.generating && !state.summariesError && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有课程总结，生成后会保留历次记录。" />
        )}
        {activeSummary === undefined && state.activeSummaryId && (
          <div className="summary-loading"><Spin /> 总结加载中…</div>
        )}
        {activeSummary === null && state.activeSummaryId && (
          <Alert type="warning" showIcon title="总结加载失败，请稍后重试" />
        )}
        {summary && (
          <article className="summary-content">
            <p className="summary-meta">生成于 {summary.generatedAtText} · {summary.citationCount} 条引用</p>
            <SummaryBlocks blocks={summary.blocks} />
            {summary.citations.length > 0 && (
              <div className="summary-citations">
                <h3>原文引用</h3>
                <ul>
                  {summary.citations.map((citation: any, index: number) => (
                    <li key={index}>
                      <blockquote>「{citation.quote}」</blockquote>
                      <Space size={8} wrap>
                        {(citation.stamp || citation.jumpUrl) && (
                          <SourceJump href={citation.jumpUrl}>{citation.stamp}</SourceJump>
                        )}
                        {citation.sessionStartedAtText && (
                          <Typography.Text type="secondary">来自 {citation.sessionStartedAtText} 的学习</Typography.Text>
                        )}
                        {citation.sessionOriginLabel && <Tag>{citation.sessionOriginLabel}</Tag>}
                      </Space>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        )}
      </CollapsibleSection>

      {finishedSessions.length > 0 && (
        <CollapsibleSection id="session-digests" title="学习纪要">
          {finishedSessions.map((session: { id: string; sourceId: string; startedAt: string }) => (
            <SessionDigestItem
              key={session.id}
              startedAt={session.startedAt}
              onRead={() => onReadSessionDigest(session.id)}
              jumpTo={(positionMs) => buildNoteJumpUrl({ sourceId: session.sourceId, positionMs }, sources)}
            />
          ))}
        </CollapsibleSection>
      )}

      <CollapsibleSection
        id="transcript"
        title="逐字稿"
        count={`${mergedView.records.length} 段 · 合并 ${sessions.length} 次学习`}
        defaultOpen={false}
      >
        {sessions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="开始学习后，逐字稿会出现在这里。" />
        ) : sessionViews.every((view: any) => view === null || view === undefined) ? (
          <Alert type="warning" showIcon title="逐字稿加载失败，请稍后重试" />
        ) : entries.length === 0 ? (
          <p className="session-hint">还没有逐字稿</p>
        ) : (
          <ul className="transcript-entries">
            {entries.map((entry: any, index: number) => (
              <li className={`transcript-entry transcript-${entry.kind}`} key={`${entry.startMs}-${index}`}>
                <div className="transcript-line">
                  {(entry.stamp || entry.jumpUrl) && (
                    <SourceJump href={entry.jumpUrl}>{entry.stamp}</SourceJump>
                  )}
                  <span className="transcript-text">{entry.text}</span>
                  {entry.kind === "record" && sessionOriginLabel(entry.origin) && (
                    <Tag color="cyan">{sessionOriginLabel(entry.origin)}</Tag>
                  )}
                </div>
                {entry.detail && <p className="transcript-detail">{entry.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <footer className="detail-delete">
        <div>
          <h2>删除资料</h2>
          <p>将同时删除逐字稿、笔记与课程总结，此操作不可撤销。</p>
        </div>
        <Button aria-label="删除资料" danger icon={<DeleteOutlined />} disabled={state.busy} onClick={onDelete}>
          删除资料
        </Button>
      </footer>
    </div>
  );
}
