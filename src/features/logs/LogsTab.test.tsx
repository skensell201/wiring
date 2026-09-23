import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore, viewEditor } from "../../app/store";
import { logBuffer } from "./logBuffer";
import { containersFromYaml, LogsTab } from "./LogsTab";

const { invoke, save, scrollToIndex, measure } = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "start_logs" ? 1 : null)),
  save: vi.fn(async (): Promise<string | null> => null),
  scrollToIndex: vi.fn(),
  measure: vi.fn(),
}));
vi.mock("../../shared/ipc/tauri", () => ({ invoke, Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
// jsdom measures the scroll element as 0x0, so the real virtualiser renders no rows: this one
// renders them all. Like the real hook it returns one stable instance. The app keeps the real one.
vi.mock("@tanstack/react-virtual", () => {
  let count = 0;
  const instance = {
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 18, size: 18, key: i })),
    getTotalSize: () => count * 18,
    scrollToIndex,
    measureElement: () => {},
    measure,
  };
  return { useVirtualizer: (opts: { count: number }) => { count = opts.count; return instance; } };
});

const pod = (id: string) => ({ id, kind: "Pod" as const, namespace: "p", name: id.split("/").pop()!, status: "ok" as const, badges: [], group: null });

const POD_YAML = "kind: Pod\nspec:\n  containers:\n    - name: app\n    - name: sidecar\n  initContainers:\n    - name: setup\n";

/** What `serde_yaml_ng::to_string` emits: indentless sequences, keys sorted, block scalars. */
const EMITTED_POD_YAML = [
  "apiVersion: v1", "kind: Pod", "metadata:", "  name: web-1", "  namespace: p",
  "spec:", "  containers:",
  "  - args:", "    - |", "      name: not-a-container", "      echo hi",
  "    env:", "    - name: FOO", "      value: bar", "    - name: BAR", "      value: baz",
  "    image: nginx", "    name: web",
  "  - image: busybox", "    name: sidecar",
  "  initContainers:", "  - image: alpine", "    name: setup",
  "status:", "  containerStatuses:", "  - name: web", "    ready: true", "  phase: Running", "",
].join("\n");

const EMITTED_CRONJOB_YAML = [
  "apiVersion: batch/v1", "kind: CronJob", "metadata:", "  name: tick",
  "spec:", "  jobTemplate:", "    spec:", "      template:", "        spec:",
  "          containers:", "          - image: alpine", "            name: tick", "          - image: envoy", "            name: proxy",
  "          restartPolicy: OnFailure",
  "  schedule: '* * * * *'", "",
].join("\n");

function setup(nodeId = "Pod/p/a", yaml = POD_YAML) {
  useAppStore.setState({
    ...initialState(),
    nodes: new Map([[nodeId, pod(nodeId)]]),
    selectedId: nodeId,
    details: { nodeId, data: { yaml, summary: [], related: [] }, events: [], loading: false, editor: viewEditor(yaml) },
  });
  return render(<LogsTab />);
}

const push = (lines: string[], podName = "a", container = "app") => act(() => {
  logBuffer.append(lines.map((text) => ({ pod: podName, container, text })));
  vi.runAllTimers();
});

const setLogs = (patch: Partial<ReturnType<typeof useAppStore.getState>["logs"]>) =>
  act(() => useAppStore.setState({ logs: { ...useAppStore.getState().logs, ...patch } }));

const options = () => [...(screen.getByLabelText("Container") as HTMLSelectElement).options].map((o) => o.textContent);

describe("containersFromYaml", () => {
  it("reads a Pod's init and regular containers, init first", () => {
    expect(containersFromYaml(POD_YAML)).toEqual([{ name: "setup", init: true }, { name: "app", init: false }, { name: "sidecar", init: false }]);
  });

  it("reads the pod template's containers of a workload", () => {
    const yaml = [
      "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: web", "spec:", "  replicas: 2", "  selector:", "    matchLabels:", "      app: web",
      "  template:", "    metadata:", "      labels:", "        app: web", "    spec:", "      initContainers:", "        - name: migrate", "          image: web:1",
      "      containers:", "        - name: web", "          image: web:1", "          ports:", "            - containerPort: 80", "        - name: proxy", "          image: envoy",
      "      volumes:", "        - name: data", "          emptyDir: {}", "",
    ].join("\n");
    expect(containersFromYaml(yaml)).toEqual([{ name: "migrate", init: true }, { name: "web", init: false }, { name: "proxy", init: false }]);
  });

  it("reads the indentless sequences the backend emits, ignoring env names, block scalars and containerStatuses", () => {
    expect(containersFromYaml(EMITTED_POD_YAML)).toEqual([{ name: "setup", init: true }, { name: "web", init: false }, { name: "sidecar", init: false }]);
  });

  it("reads a CronJob's job template containers", () => {
    expect(containersFromYaml(EMITTED_CRONJOB_YAML)).toEqual([{ name: "tick", init: false }, { name: "proxy", init: false }]);
  });

  it("tolerates extra spaces after the dash and quoted names", () => {
    expect(containersFromYaml("spec:\n  containers:\n  -   image: x\n      name: \"web\"\n")).toEqual([{ name: "web", init: false }]);
  });

  it("returns nothing for YAML without containers", () => {
    expect(containersFromYaml("kind: ConfigMap\ndata:\n  containers: x\n")).toEqual([]);
    expect(containersFromYaml("")).toEqual([]);
  });
});

describe("LogsTab", () => {
  beforeEach(() => { vi.useFakeTimers(); logBuffer.clear(); invoke.mockClear(); save.mockClear(); scrollToIndex.mockClear(); measure.mockClear(); });
  // The buffer notifies once per animation frame and holds a "scheduled" flag until that frame
  // runs; a frame left pending on a fake clock that the next test replaces would wedge it.
  afterEach(() => { act(() => { cleanup(); vi.runAllTimers(); }); vi.useRealTimers(); });

  it("starts the session on mount and stops it on unmount", async () => {
    const { unmount } = setup();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("start_logs", expect.objectContaining({ nodeId: "Pod/p/a" }));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "start_logs")).toHaveLength(1);
    unmount();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("stop_logs", { sessionId: 1 });
  });

  it("lists containers from the object's YAML, init ones marked", async () => {
    setup();
    await act(async () => {});
    expect(options()).toEqual(["All containers", "setup (init)", "app", "sidecar"]);
    fireEvent.change(screen.getByLabelText("Container"), { target: { value: "sidecar" } });
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ container: "sidecar" }));
  });

  it("lists the containers of the running streams when the object has no YAML (a PodGroup)", async () => {
    setup("PodGroup/p/Deployment/web", "");
    await act(async () => {});
    expect(options()).toEqual(["All containers"]);
    setLogs({ status: "streaming", streams: new Map([["web-1/proxy", { state: "started" }], ["web-1/app", { state: "started" }], ["web-2/app", { state: "started" }]]) });
    expect(options()).toEqual(["All containers", "app", "proxy"]);
  });

  it("keeps a selected container the YAML no longer lists as a disabled option", async () => {
    setup();
    await act(async () => {});
    setLogs({ container: "gone" });
    const select = screen.getByLabelText("Container") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    const missing = [...select.options].find((o) => o.value === "gone")!;
    expect(missing.textContent).toBe("gone (missing)");
    expect(missing.disabled).toBe(true);
    setLogs({ container: "app" });
    expect(options()).toEqual(["All containers", "setup (init)", "app", "sidecar"]);
  });

  it("renders lines with ANSI colours and a pod prefix only when several streams run", async () => {
    setup();
    await act(async () => {});
    push(["plain", "\u001b[31mred\u001b[0m"]);
    expect(screen.getByText("plain")).toBeInTheDocument();
    expect(screen.getByText("red")).toHaveClass("ansi-red");
    expect(screen.queryByText("[a/app]")).not.toBeInTheDocument();
    setLogs({ streams: new Map([["a/app", { state: "started" }], ["b/app", { state: "started" }]]), status: "streaming" });
    expect(screen.getAllByText("[a/app]").length).toBeGreaterThan(0);
  });

  it("search counts and highlights matches", async () => {
    setup();
    await act(async () => {});
    push(["GET /", "POST /", "GET /x"]);
    fireEvent.change(screen.getByLabelText("Search logs"), { target: { value: "get" } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getAllByTestId("match")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Previous match"));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("Enter steps to the next match and wraps; Shift+Enter steps back", async () => {
    setup();
    await act(async () => {});
    push(["GET /", "POST /", "GET /x"]);
    const input = screen.getByPlaceholderText("Search logs");
    fireEvent.change(input, { target: { value: "get" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("scrolls to a match on search actions only, not on every batch that arrives", async () => {
    setup();
    await act(async () => {});
    push(["GET /", "POST /"]);
    fireEvent.change(screen.getByPlaceholderText("Search logs"), { target: { value: "get" } });
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "center" });
    scrollToIndex.mockClear();
    push(["more", "lines"]);
    expect(scrollToIndex).not.toHaveBeenCalled();
    push(["GET /y"]); // now rows 0 and 4 match
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(scrollToIndex).toHaveBeenLastCalledWith(4, { align: "center" });
  });

  it("unsticks when the user scrolls up and the Follow button re-sticks to the bottom", async () => {
    setup();
    await act(async () => {});
    push(["one", "two", "three"]);
    expect(screen.queryByRole("button", { name: "↓ Follow" })).not.toBeInTheDocument();
    const view = screen.getByTestId("log-view");
    Object.defineProperty(view, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(view, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(view, "scrollTop", { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(view);
    scrollToIndex.mockClear();
    push(["four"]);
    expect(scrollToIndex).not.toHaveBeenCalled(); // unstuck: new lines do not move the view
    fireEvent.click(screen.getByRole("button", { name: "↓ Follow" }));
    expect(scrollToIndex).toHaveBeenLastCalledWith(3, { align: "end" });
    expect(screen.queryByRole("button", { name: "↓ Follow" })).not.toBeInTheDocument();
    view.scrollTop = 600;
    fireEvent.scroll(view);
    expect(screen.queryByRole("button", { name: "↓ Follow" })).not.toBeInTheDocument();
  });

  it("keeps following the bottom once the buffer saturates and each batch drops as many lines", async () => {
    setup();
    await act(async () => {});
    push(Array.from({ length: 10_000 }, (_, i) => `line ${i}`));
    scrollToIndex.mockClear();
    push(["fresh"]); // the row count no longer changes, but the bottom row is a new line
    expect(scrollToIndex).toHaveBeenLastCalledWith(9_999, { align: "end" });
  });

  it("shows stream problems as lines and the status on the right", async () => {
    setup();
    await act(async () => {});
    setLogs({ status: "error", streams: new Map([["a/app", { state: "error", message: 'container "app" is waiting to start: ImagePullBackOff' }]]) });
    expect(screen.getByText(/waiting to start: ImagePullBackOff/)).toBeInTheDocument();
    setLogs({ status: "streaming", truncated: true, streams: new Map([["a/app", { state: "started" }]]) });
    expect(screen.getByText(/streaming · 1 stream/)).toBeInTheDocument();
    expect(screen.getByText(/truncated to 64 streams/)).toBeInTheDocument();
  });

  it("Previous, Timestamps and Wrap toggle; Clear empties the buffer; Download saves the text", async () => {
    setup();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ previous: true }));
    fireEvent.click(screen.getByRole("button", { name: "Timestamps" }));
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ timestamps: true }));
    measure.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
    expect(screen.getByTestId("log-view")).toHaveClass("whitespace-pre-wrap");
    expect(measure).toHaveBeenCalled(); // wrapped rows change height: re-measure
    push(["x"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    act(() => vi.runAllTimers());
    expect(screen.queryByText("x")).not.toBeInTheDocument();
    push(["one", "two"]);
    save.mockResolvedValueOnce("/tmp/a.log");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("save_text", { path: "/tmp/a.log", text: "one\ntwo\n" });
  });

  it("Download prefixes lines with the stream when several streams run", async () => {
    setup();
    await act(async () => {});
    setLogs({ status: "streaming", streams: new Map([["a/app", { state: "started" }], ["b/app", { state: "started" }]]) });
    push(["one"], "a");
    push(["two"], "b");
    save.mockResolvedValueOnce("/tmp/a.log");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("save_text", { path: "/tmp/a.log", text: "[a/app] one\n[b/app] two\n" });
  });

  it("Download reports a failed save dialog as a toast", async () => {
    setup();
    await act(async () => {});
    save.mockRejectedValueOnce(new Error("no dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(async () => {});
    expect(useAppStore.getState().toasts.map((t) => t.message)).toEqual(["no dialog"]);
    expect(invoke).not.toHaveBeenCalledWith("save_text", expect.anything());
  });
});
