import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError } from "../../shared/ipc/types";
import { logBuffer } from "./logBuffer";
import { LogView, type Problem } from "./LogView";

export interface ContainerOption { name: string; init: boolean }

/** Container names from the selected object's YAML: a Pod's own `spec.containers`, or for a
 *  workload the pod template's — the first `containers:` block at any indent is the template's,
 *  since no workload spec has one of its own. Only the list's direct items are read, so an
 *  `env: - name:` inside a container or the `containerStatuses` further down never leak in. */
export function containersFromYaml(yaml: string): ContainerOption[] {
  const lines = yaml.split("\n");
  const out: ContainerOption[] = [];
  const grab = (key: "initContainers" | "containers", init: boolean) => {
    const start = lines.findIndex((l) => new RegExp(`^[ \\t]*${key}:[ \\t]*$`).test(l));
    if (start === -1) return;
    const indent = /^[ \t]*/.exec(lines[start])![0].length;
    let keyIndent: number | null = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const lineIndent = /^[ \t]*/.exec(line)![0].length;
      if (lineIndent <= indent) break; // the block ended
      const dash = /^([ \t]*)-[ \t]+(.*)$/.exec(line);
      let text: string, at: number;
      if (dash && (keyIndent === null || dash[1].length < keyIndent)) {
        keyIndent = dash[1].length + 2;
        text = dash[2]; at = keyIndent;
      } else { text = line.trimStart(); at = lineIndent; }
      const name = at === keyIndent ? /^name:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/.exec(text)?.[1] : undefined;
      if (name) out.push({ name, init });
    }
  };
  grab("initContainers", true);
  grab("containers", false);
  return out;
}

const chip = (on: boolean) => `rounded-md border px-2 py-0.5 text-xs ${on ? "border-current-b bg-current-b/20 text-text-hi" : "border-border text-text-muted hover:text-text"}`;

export function LogsTab() {
  const { nodeId, yaml, logs, startLogs, stopLogs, setLogsContainer, toggleLogsPrevious, toggleLogsTimestamps, toast } = useAppStore(useShallow((s) => ({
    nodeId: s.details?.nodeId ?? null, yaml: s.details?.data?.yaml ?? "", logs: s.logs,
    startLogs: s.startLogs, stopLogs: s.stopLogs, setLogsContainer: s.setLogsContainer, toggleLogsPrevious: s.toggleLogsPrevious, toggleLogsTimestamps: s.toggleLogsTimestamps, toast: s.toast,
  })));
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [wrap, setWrap] = useState(false);

  // One session per selected node for the tab's lifetime; the store actions are stable, so this
  // runs on mount, on a node change and on unmount only.
  useEffect(() => {
    if (!nodeId) return;
    void startLogs(nodeId);
    return () => { void stopLogs(); };
  }, [nodeId, startLogs, stopLogs]);

  const containers = useMemo(() => containersFromYaml(yaml), [yaml]);
  const problems: Problem[] = [...logs.streams].flatMap(([key, s]) => (s.state === "error" ? [{ key, message: s.message }] : []));
  const live = [...logs.streams.values()].filter((s) => s.state === "started").length;
  const status = logs.status === "streaming" ? `● streaming · ${live} ${live === 1 ? "stream" : "streams"}` : logs.status === "starting" ? "connecting…" : logs.status;
  const onMatches = useCallback((n: number) => { setMatchCount(n); setCurrent((c) => Math.min(c, Math.max(0, n - 1))); }, []);

  const download = async () => {
    const path = await save({ defaultPath: `${nodeId?.split("/").pop() ?? "logs"}.log`, filters: [{ name: "Log", extensions: ["log", "txt"] }] });
    if (!path) return;
    try {
      await commands.saveText(path, logBuffer.lines().map((l) => l.text).join("\n") + "\n");
    } catch (e) {
      toast(toAppError(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <select aria-label="Container" value={logs.container ?? ""} onChange={(e) => void setLogsContainer(e.target.value || null)}
          className="no-drag rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-hi">
          <option value="">All containers</option>
          {containers.map((c) => <option key={c.name} value={c.name}>{c.init ? `${c.name} (init)` : c.name}</option>)}
        </select>
        <button type="button" className={chip(logs.previous)} aria-pressed={logs.previous} onClick={() => void toggleLogsPrevious()}>Previous</button>
        <button type="button" className={chip(logs.timestamps)} aria-pressed={logs.timestamps} onClick={() => void toggleLogsTimestamps()}>Timestamps</button>
        <button type="button" className={chip(wrap)} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>Wrap</button>
        <div className="ml-2 flex items-center gap-1">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setCurrent(0); }} placeholder="Search logs"
            onKeyDown={(e) => { if (e.key === "Enter" && matchCount) { e.preventDefault(); setCurrent((c) => (e.shiftKey ? (c - 1 + matchCount) % matchCount : (c + 1) % matchCount)); } }}
            className="w-44 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-hi outline-none focus:border-current-b" />
          {query && <span className="tabular-nums text-text-muted">{matchCount ? `${current + 1} / ${matchCount}` : "0 / 0"}</span>}
          <button type="button" aria-label="Previous match" disabled={!matchCount} onClick={() => setCurrent((c) => (c - 1 + matchCount) % matchCount)} className="px-1 text-text-muted hover:text-text-hi disabled:opacity-40">↑</button>
          <button type="button" aria-label="Next match" disabled={!matchCount} onClick={() => setCurrent((c) => (c + 1) % matchCount)} className="px-1 text-text-muted hover:text-text-hi disabled:opacity-40">↓</button>
        </div>
        <button type="button" className={chip(false)} onClick={() => logBuffer.clear()}>Clear</button>
        <button type="button" className={chip(false)} onClick={() => void download()}>Download</button>
        <span className="ml-auto text-text-muted">
          {logs.truncated && <span className="mr-2 text-status-warn">truncated to 64 streams</span>}
          <span className={logs.status === "streaming" ? "text-status-ok" : ""}>{status}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <LogView query={query} current={current} wrap={wrap} showPrefix={logs.streams.size > 1} problems={problems} onMatches={onMatches} />
      </div>
    </div>
  );
}
