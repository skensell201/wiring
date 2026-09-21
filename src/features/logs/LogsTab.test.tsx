import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore, viewEditor } from "../../app/store";
import { logBuffer } from "./logBuffer";
import { containersFromYaml, LogsTab } from "./LogsTab";

const { invoke, save } = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "start_logs" ? 1 : null)),
  save: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../../shared/ipc/tauri", () => ({ invoke, Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
// jsdom measures the scroll element as 0x0, so the real virtualiser renders no rows: this one
// renders them all. The app keeps the real one.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 18, size: 18, key: i })),
    getTotalSize: () => count * 18,
    scrollToIndex: vi.fn(),
  }),
}));

const pod = (id: string) => ({ id, kind: "Pod" as const, namespace: "p", name: id.split("/").pop()!, status: "ok" as const, badges: [], group: null });

const POD_YAML = "kind: Pod\nspec:\n  containers:\n    - name: app\n    - name: sidecar\n  initContainers:\n    - name: setup\n";

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

  it("returns nothing for YAML without containers", () => {
    expect(containersFromYaml("kind: ConfigMap\ndata:\n  containers: x\n")).toEqual([]);
  });
});

describe("LogsTab", () => {
  beforeEach(() => { vi.useFakeTimers(); logBuffer.clear(); invoke.mockClear(); save.mockClear(); });
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
    const select = screen.getByLabelText("Container") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["All containers", "setup (init)", "app", "sidecar"]);
    fireEvent.change(select, { target: { value: "sidecar" } });
    await act(async () => {});
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ container: "sidecar" }));
  });

  it("renders lines with ANSI colours and a pod prefix only when several streams run", async () => {
    setup();
    await act(async () => {});
    push(["plain", "\u001b[31mred\u001b[0m"]);
    expect(screen.getByText("plain")).toBeInTheDocument();
    expect(screen.getByText("red")).toHaveClass("ansi-red");
    expect(screen.queryByText("[a/app]")).not.toBeInTheDocument();
    act(() => useAppStore.setState({ logs: { ...useAppStore.getState().logs, streams: new Map([["a/app", { state: "started" }], ["b/app", { state: "started" }]]), status: "streaming" } }));
    expect(screen.getAllByText("[a/app]").length).toBeGreaterThan(0);
  });

  it("search counts and highlights matches", async () => {
    setup();
    await act(async () => {});
    push(["GET /", "POST /", "GET /x"]);
    fireEvent.change(screen.getByPlaceholderText("Search logs"), { target: { value: "get" } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getAllByTestId("match")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("shows stream problems as lines and the status on the right", async () => {
    setup();
    await act(async () => {});
    act(() => useAppStore.setState({ logs: { ...useAppStore.getState().logs, status: "error", streams: new Map([["a/app", { state: "error", message: 'container "app" is waiting to start: ImagePullBackOff' }]]) } }));
    expect(screen.getByText(/waiting to start: ImagePullBackOff/)).toBeInTheDocument();
    act(() => useAppStore.setState({ logs: { ...useAppStore.getState().logs, status: "streaming", truncated: true, streams: new Map([["a/app", { state: "started" }]]) } }));
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
    fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
    expect(screen.getByTestId("log-view")).toHaveClass("whitespace-pre-wrap");
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
});
