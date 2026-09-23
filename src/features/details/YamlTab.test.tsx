import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore, viewEditor, type EditorState } from "../../app/store";
import { YamlTab } from "./YamlTab";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("./yaml", () => ({ highlightYaml: vi.fn(async (src: string) => `<pre class="shiki"><code>${src}</code></pre>`) }));
vi.mock("../editor/LazyYamlEditor", () => ({
  LazyYamlEditor: ({ value, onChange, label, readOnly }: { value: string; onChange: (t: string) => void; label: string; readOnly?: boolean }) => (
    <textarea aria-label={label} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const YAML = "kind: Pod\nmetadata:\n  name: web-1\n";

function setDetails(editor: Partial<EditorState> = {}, nodeId = "Pod/p/web-1") {
  useAppStore.setState({
    ...initialState(),
    selectedId: nodeId,
    details: { nodeId, loading: false, events: [], data: { yaml: YAML, summary: [], related: [] }, editor: { ...viewEditor(YAML), ...editor } },
  });
}

const actions = () => {
  const a = { startEdit: vi.fn(), setBuffer: vi.fn(), reviewEdit: vi.fn(), backToEdit: vi.fn(), applyEdit: vi.fn(async () => {}), cancelEdit: vi.fn(), reloadEdit: vi.fn(async () => {}) };
  useAppStore.setState(a);
  return a;
};

beforeEach(() => setDetails());

describe("YamlTab in view mode", () => {
  it("renders the highlighted YAML with Copy and Edit; Edit starts editing", async () => {
    const a = actions();
    render(<YamlTab />);
    expect(await screen.findByText(/kind: Pod/)).toBeInTheDocument();
    expect(screen.getByTitle("Copy YAML")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(a.startEdit).toHaveBeenCalled();
  });

  it("offers no Edit for a PodGroup (a synthetic node)", () => {
    setDetails({}, "PodGroup/p/Deployment/web");
    render(<YamlTab />);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("says so when there is no YAML", () => {
    useAppStore.setState((s) => ({ details: { ...s.details!, data: { yaml: "", summary: [], related: [] } } }));
    render(<YamlTab />);
    expect(screen.getByText(/no yaml/i)).toBeInTheDocument();
  });
});

describe("YamlTab in edit mode", () => {
  it("shows the editor with the buffer; typing updates it; Save reviews and Cancel cancels", () => {
    const a = actions();
    setDetails({ mode: "edit", buffer: YAML });
    render(<YamlTab />);
    const editor = screen.getByLabelText("YAML editor") as HTMLTextAreaElement;
    expect(editor.value).toBe(YAML);
    fireEvent.change(editor, { target: { value: "kind: Pod\n" } });
    expect(a.setBuffer).toHaveBeenCalledWith("kind: Pod\n");
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect(a.reviewEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(a.cancelEdit).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("edit-mode buttons and editor are disabled while saving", () => {
    // Overwrite from the conflict banner writes from edit mode; the buffer must not move under it.
    setDetails({ mode: "edit", buffer: YAML + "x: 1\n", saving: true, error: { kind: "conflict", message: "the object has been modified" } });
    render(<YamlTab />);
    expect(screen.getByLabelText("YAML editor")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overwrite" })).toBeDisabled();
  });

  it("conflict: a banner with Reload and Overwrite (which forces the write)", () => {
    const a = actions();
    setDetails({ mode: "edit", buffer: YAML + "x: 1\n", error: { kind: "conflict", message: "the object has been modified" } });
    render(<YamlTab />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-kind", "conflict");
    expect(banner).toHaveTextContent(/changed on the server while you were editing/i);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(a.reloadEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    expect(a.applyEdit).toHaveBeenCalledWith(true);
  });

  it("invalid: a banner with the server's message kept verbatim", () => {
    setDetails({ mode: "edit", buffer: YAML, error: { kind: "invalid", message: "spec.replicas: Invalid value: -1\nspec.x: unknown field" } });
    render(<YamlTab />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-kind", "invalid");
    const msg = screen.getByText(/spec.replicas: Invalid value: -1/);
    expect(msg.textContent).toBe("spec.replicas: Invalid value: -1\nspec.x: unknown field");
    expect(msg.className).toMatch(/whitespace-pre-wrap/);
    expect(msg.className).toMatch(/font-mono/);
    expect(screen.queryByRole("button", { name: "Overwrite" })).not.toBeInTheDocument();
  });

  it("notFound: the object was deleted; Reload is offered", () => {
    const a = actions();
    setDetails({ mode: "edit", buffer: YAML, error: { kind: "notFound", message: "This object was deleted on the server." } });
    render(<YamlTab />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-kind", "notFound");
    expect(banner).toHaveTextContent(/deleted on the server/i);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(a.reloadEdit).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Overwrite" })).not.toBeInTheDocument();
  });

  it("any other error: a plain banner with the message", () => {
    setDetails({ mode: "edit", buffer: YAML, error: { kind: "forbidden", message: "configmaps is forbidden" } });
    render(<YamlTab />);
    expect(screen.getByRole("alert")).toHaveTextContent("configmaps is forbidden");
  });
});

describe("YamlTab in review mode", () => {
  it("shows the diff with Apply and Back", () => {
    const a = actions();
    setDetails({ mode: "review", buffer: YAML + "x: 1\n" });
    render(<YamlTab />);
    expect(screen.getByText("1 line changed")).toBeInTheDocument();
    expect(screen.getByText("+ x: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(a.applyEdit).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(a.backToEdit).toHaveBeenCalled();
  });

  it("disables the buttons while saving", () => {
    setDetails({ mode: "review", buffer: YAML + "x: 1\n", saving: true });
    render(<YamlTab />);
    expect(screen.getByRole("button", { name: /Applying/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });
});
