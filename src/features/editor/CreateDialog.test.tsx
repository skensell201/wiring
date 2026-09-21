import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { CreateDialog } from "./CreateDialog";
import { template } from "./templates";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("./LazyYamlEditor", () => ({
  LazyYamlEditor: ({ value, onChange, label }: { value: string; onChange: (t: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

beforeEach(() => {
  useAppStore.setState({ ...initialState(), connection: { ...initialState().connection, context: "prod", namespace: "shop" } });
});

describe("CreateDialog", () => {
  it("renders nothing while closed", () => {
    render(<CreateDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with the Deployment template; switching the kind re-templates the buffer", () => {
    useAppStore.getState().openCreate();
    render(<CreateDialog />);
    expect(screen.getByRole("dialog", { name: /create/i })).toBeInTheDocument();
    const editor = screen.getByLabelText("Manifest") as HTMLTextAreaElement;
    expect(editor.value).toBe(template("Deployment", "shop"));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "ConfigMap" } });
    expect(useAppStore.getState().createDialog.kind).toBe("ConfigMap");
    expect((screen.getByLabelText("Manifest") as HTMLTextAreaElement).value).toBe(template("ConfigMap", "shop"));
  });

  it("lists every creatable kind, PodGroup excluded", () => {
    useAppStore.getState().openCreate();
    render(<CreateDialog />);
    const options = Array.from((screen.getByLabelText("Kind") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain("PersistentVolume");
    expect(options).not.toContain("PodGroup");
    expect(options).toHaveLength(15);
  });

  it("typing edits the buffer; Create submits; Cancel closes", () => {
    const submitCreate = vi.fn(async () => {});
    useAppStore.getState().openCreate("ConfigMap");
    useAppStore.setState({ submitCreate });
    render(<CreateDialog />);
    fireEvent.change(screen.getByLabelText("Manifest"), { target: { value: "kind: ConfigMap\n" } });
    expect(useAppStore.getState().createDialog.buffer).toBe("kind: ConfigMap\n");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(submitCreate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().createDialog.open).toBe(false);
  });

  it("shows the server error in a banner and disables Create while submitting", () => {
    useAppStore.getState().openCreate("ConfigMap");
    useAppStore.setState((s) => ({ createDialog: { ...s.createDialog, error: { kind: "invalid", message: "metadata.name: Invalid value" } } }));
    const { unmount } = render(<CreateDialog />);
    expect(screen.getByRole("alert")).toHaveTextContent("metadata.name: Invalid value");
    unmount();

    useAppStore.setState((s) => ({ createDialog: { ...s.createDialog, error: null, submitting: true } }));
    render(<CreateDialog />);
    expect(screen.getByRole("button", { name: /Creating/ })).toBeDisabled();
  });
});
