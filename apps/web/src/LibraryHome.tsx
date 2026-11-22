import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Dropdown, Input, Spin, Tabs } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";
import { buildNoteJumpUrl, formatPosition, noteKindLabel, platformLabel, presentListItem } from "../public/js/library.js";
import searchIcon from "./assets/library-search.svg";
import videoIcon from "./assets/source-video.svg";
import webIcon from "./assets/source-web.svg";

type Source = {
  id: string;
  url: string;
  platformId?: string | null;
  platformVideoId?: string | null;
  lastStudiedAtMs?: number;
  durationMs?: number;
  thumbnailUrl?: string;
  progress?: { positionMs: number; revision: number } | null;
};
type Collection = {
  resource: { id: string; title: string; kind: string };
  sources: Source[];
};
type Note = {
  id: string;
  resourceId: string;
  sourceId: string | null;
  positionMs: number | null;
  kind?: "manual" | "excerpt";
  text: string;
};
type Panel = "resources" | "notes";

const BATCH_SIZE = 6;
const SEARCH_LABELS = {
  resources: "搜索资料标题",
  notes: "搜索笔记正文或课程名",
};

function sourceDomain(source?: Source) {
  try {
    return source ? new URL(source.url).hostname : "";
  } catch {
    return "";
  }
}

function Cover({ source, kind, eager = false }: { source?: Source; kind: string; eager?: boolean }) {
  const id = source?.platformVideoId;
  const url = source?.platformId === "youtube" && id && /^[\w-]{11}$/.test(id)
    ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    : source?.platformId === "bilibili" && /^https:\/\/i[012]\.hdslb\.com\//.test(source.thumbnailUrl ?? "")
      ? source.thumbnailUrl
      : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  return (
    <div className="library-cover" aria-hidden="true">
      <span>{kind}</span>
      <strong>{sourceDomain(source)}</strong>
      {url && (
        <img alt="" src={url} loading={eager ? "eager" : "lazy"} referrerPolicy="no-referrer"
          className={loadedUrl === url ? "cover-loaded" : undefined} onLoad={() => setLoadedUrl(url)} />
      )}
    </div>
  );
}

export default function LibraryHome({
  resources, active, busy, error, listNotes, onReload, onCollect, onOpen, onDelete,
}: {
  resources: Collection[];
  active: boolean;
  busy: boolean;
  error: string | null;
  listNotes?: () => Promise<{ ok: boolean; data?: { notes?: Note[]; error?: { message?: string } } }>;
  onReload: () => void;
  onCollect: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [panel, setPanel] = useState<Panel>("resources");
  const searchId = useId();
  const [query, setQuery] = useState({ resources: "", notes: "" });
  const [browseLimit, setBrowseLimit] = useState({ resources: BATCH_SIZE, notes: BATCH_SIZE });
  const [searchLimit, setSearchLimit] = useState({ resources: BATCH_SIZE, notes: BATCH_SIZE });
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesError, setNotesError] = useState("");
  const [notesLoading, setNotesLoading] = useState(Boolean(listNotes));
  const [notesRefresh, setNotesRefresh] = useState(0);
  const browsePosition = useRef<Partial<Record<Panel, number>>>({});
  const restorePosition = useRef<number | undefined>(undefined);
  const search = query[panel].trim().toLowerCase();

  useEffect(() => {
    if (!active || !listNotes) return;
    let current = true;
    setNotesLoading(true);
    setNotesError("");
    void listNotes().then((result) => {
      if (!current) return;
      if (result.ok) setNotes(result.data?.notes ?? []);
      else setNotesError(result.data?.error?.message || "笔记加载失败");
      setNotesLoading(false);
    });
    return () => { current = false; };
  }, [active, listNotes, notesRefresh]);

  useEffect(() => {
    if (!active || !listNotes) return;
    function handleFocus() {
      setNotesRefresh((count) => count + 1);
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [active, listNotes]);

  useLayoutEffect(() => {
    if (restorePosition.current === undefined) return;
    window.scrollTo(0, restorePosition.current);
    restorePosition.current = undefined;
  }, [query]);

  function changeQuery(value: string) {
    if (!search && value.trim()) browsePosition.current[panel] = window.scrollY;
    if (search && !value.trim()) restorePosition.current = browsePosition.current[panel];
    setQuery((previous) => ({ ...previous, [panel]: value }));
    setSearchLimit((previous) => ({ ...previous, [panel]: BATCH_SIZE }));
  }

  const items = useMemo(() => new Map(resources.map((item) => [item.resource.id, item])), [resources]);
  const libraryNotes = useMemo(() => notes.filter((note) => items.has(note.resourceId)), [notes, items]);
  const resume = useMemo(() => {
    let latest: { item: Collection; source: Source; positionMs: number; durationMs?: number; stamp: string; href: string; time: number } | undefined;
    for (const item of resources) {
      for (const source of item.sources) {
        const positionMs = source.progress?.positionMs ?? 0;
        const durationMs = source.durationMs;
        const stamp = formatPosition(positionMs);
        const time = source.lastStudiedAtMs ?? 0;
        if (!stamp || positionMs <= 0 || (durationMs && positionMs >= durationMs) || (latest && time <= latest.time)) continue;
        const href = buildNoteJumpUrl({ sourceId: source.id, positionMs }, item.sources);
        if (href) latest = { item, source, positionMs, durationMs, stamp, href, time };
      }
    }
    return latest;
  }, [resources]);

  const matchingResources = resources.filter(({ resource }) => resource.title.toLowerCase().includes(search));
  const matchingNotes = libraryNotes.filter((note) => (
    note.text.toLowerCase().includes(search) || items.get(note.resourceId)?.resource.title.toLowerCase().includes(search)
  ));

  const limit = (search ? searchLimit : browseLimit)[panel];
  const visibleResources = matchingResources.slice(0, limit);
  const noteGroups = new Map<string, Note[]>();
  for (const note of matchingNotes.slice(0, limit)) {
    const group = noteGroups.get(note.resourceId);
    if (group) group.push(note);
    else noteGroups.set(note.resourceId, [note]);
  }
  const total = panel === "resources" ? matchingResources.length : matchingNotes.length;
  const loading = panel === "resources" ? busy && resources.length === 0 : notesLoading && libraryNotes.length === 0;
  const loadError = panel === "resources" ? error : notesError;

  const list = (
    <>
      {loadError && (
        <Alert showIcon type="error" title={loadError} action={
          <Button onClick={panel === "resources" ? onReload : () => setNotesRefresh((count) => count + 1)}>重试</Button>
        } />
      )}
      {loading ? <div className="list-loading"><Spin aria-label="加载中" /></div> : total === 0 ? (
        !loadError && <div className="library-empty">
          <h2>{search ? "没有匹配结果" : panel === "notes" ? "还没有课程笔记" : "收藏的网页和课程会出现在这里。"}</h2>
          {search ? (
            <Button type="text" onClick={() => changeQuery("")}>清空搜索</Button>
          ) : panel === "resources" ? (
            <Button type="primary" onClick={onCollect}>收藏第一条资料</Button>
          ) : (
            <p>在插件里学习时写下的笔记，会按课程汇总到这里。</p>
          )}
        </div>
      ) : (
        <>
          {panel === "resources" ? (
            <ul className="resource-list">
              {visibleResources.map((item) => {
                const presented = presentListItem(item);
                const source = item.sources[0];
                const isWeb = item.resource.kind === "webpage";
                const sourceName = presented.platformLabel || [presented.kindLabel, sourceDomain(source)].filter(Boolean).join(" · ");
                return (
                  <li className="resource-item" key={presented.id}>
                    <Cover source={source} kind={presented.kindLabel} />
                    <div className="resource-item-main">
                      <a className="resource-title" href={`/?resource=${encodeURIComponent(presented.id)}`} onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onOpen(presented.id);
                      }}>{presented.title}</a>
                      <div className="resource-meta">
                        <img src={isWeb ? webIcon : videoIcon} alt="" /> {sourceName}
                      </div>
                    </div>
                    <Dropdown trigger={["click"]} menu={{
                      items: [{ key: "delete", label: "删除", danger: true, disabled: busy }],
                      onClick: () => onDelete(presented.id),
                    }}>
                      <Button className="resource-actions" type="text" icon={<EllipsisOutlined />} aria-label={`资料操作：${presented.title}`} />
                    </Dropdown>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="library-note-groups">
              {Array.from(noteGroups, ([id, group]) => {
                const item = items.get(id)!;
                return (
                  <section className="library-note-group" key={id}>
                    <header>
                      <h2>{item.resource.title}</h2>
                      <Button type="text" onClick={() => onOpen(id)}>查看课程 →</Button>
                    </header>
                    <ul>
                      {group.map((note) => {
                        const stamp = formatPosition(note.positionMs);
                        const jump = stamp && buildNoteJumpUrl(note, item.sources);
                        return (
                          <li key={note.id}>
                            <p>{note.text}</p>
                            <small>
                              {noteKindLabel(note)}
                              {jump ? <a href={jump} target="_blank" rel="noreferrer">回到 {stamp} ↗</a> : stamp && <span>{stamp}</span>}
                            </small>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          <div className="library-pagination">
            <span aria-live="polite">已显示 {Math.min(limit, total)} / {total} {panel === "resources" ? "项资料" : "条笔记"}</span>
            {limit < total && (
              <Button onClick={() => (search ? setSearchLimit : setBrowseLimit)((previous) => ({
                ...previous, [panel]: previous[panel] + BATCH_SIZE,
              }))}>加载更多</Button>
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <section className="content-inner library-home" hidden={!active} aria-label="我的学习库">
      {resume && (
        <section className="resume-section" aria-labelledby="resumeHeading">
          <h2 id="resumeHeading">继续学习</h2>
          <div className="resume-card">
            <Cover key={resume.source.id} source={resume.source} kind={presentListItem(resume.item).kindLabel} eager />
            <div className="resume-text">
              <div className="resume-label">上次学到</div>
              <h3>{resume.item.resource.title}</h3>
              <div className="resume-meta">
                <span>{platformLabel(resume.source.platformId) || sourceDomain(resume.source)}</span>
                <span className="resume-stamp">{resume.stamp}</span>
              </div>
              {resume.durationMs && (
                <progress className="resume-progress" value={resume.positionMs} max={resume.durationMs} aria-label="学习进度" />
              )}
            </div>
            <Button type="primary" href={resume.href} target="_blank" rel="noreferrer">继续学习 →</Button>
          </div>
        </section>
      )}
      <Tabs className="library-tabs" activeKey={panel} onChange={(key) => {
        setPanel(key as Panel);
        if (key === "notes") setNotesRefresh((count) => count + 1);
      }} renderTabBar={(props, TabBar) => (
        <div className="library-toolbar">
          <TabBar {...props} />
          <div className="library-search-field">
            <label htmlFor={searchId}>{SEARCH_LABELS[panel]}</label>
            <Input
              id={searchId}
              className="library-search"
              aria-label={SEARCH_LABELS[panel]}
              prefix={<img src={searchIcon} alt="" />}
              placeholder={SEARCH_LABELS[panel]}
              allowClear
              value={query[panel]}
              onChange={(event) => changeQuery(event.target.value)}
            />
          </div>
        </div>
      )} items={[
        { key: "resources", label: <>学习资料 <small>{resources.length}</small></>, children: panel === "resources" ? list : null },
        { key: "notes", label: <>笔记汇总 <small>{notesLoading && libraryNotes.length === 0 ? null : notesError ? null : libraryNotes.length}</small></>, children: panel === "notes" ? list : null },
      ]} />
    </section>
  );
}
