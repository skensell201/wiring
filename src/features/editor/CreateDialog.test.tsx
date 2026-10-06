import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { CreateDialog } from "./CreateDialog";
import { customTemplate, template } from "./templates";

// create_object answers with the new object's id, as the backend does; everything else with null.
vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "create_object" ? "ConfigMap/shop/created" : null)), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("./LazyYamlEditor", () => ({
  LazyYamlEditor: ({ value, onChange, label }: { value: string; onChange: (t: string) => void; label: string }) => (
    <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const realSubmitCreate = useAppStore.getState().submitCreate;

beforeEach(() => {
  useAppStore.setState({ ...initialState(), submitCreate: realSubmitCreate, connection: { ...initialState().connection, context: "prod", scope: ["shop"] } });
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
    expect(options).toHaveLength(18);
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

  it("offers a Namespace select defaulting to the first selected namespace and re-templates on change", async () => {
    const { invoke } = await import("../../shared/ipc/tauri");
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b"], scope: ["b", "a"] } });
    useAppStore.getState().openCreate("ConfigMap");
    render(<CreateDialog />);
    const select = screen.getByLabelText("Namespace") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("b");
    expect((screen.getByLabelText("Manifest") as HTMLTextAreaElement).value).toContain("namespace: b");
    fireEvent.change(select, { target: { value: "a" } });
    expect((screen.getByLabelText("Manifest") as HTMLTextAreaElement).value).toContain("namespace: a");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("create_object", expect.objectContaining({ namespace: "a" })));
  });

  it("uses a text input when the namespaces are unknown, and hides the field for PersistentVolume", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [], scope: ["x"] } });
    useAppStore.getState().openCreate("ConfigMap");
    render(<CreateDialog />);
    expect(screen.getByLabelText("Namespace").tagName).toBe("INPUT");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "PersistentVolume" } });
    expect(screen.queryByLabelText("Namespace")).toBeNull();
  });

  it("starts from the open custom kind's template, without the kind picker", () => {
    const r = { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true };
    useAppStore.setState({ view: { name: "custom", resource: r }, connection: { ...useAppStore.getState().connection, scope: ["shop"], namespaces: ["shop"] } });
    useAppStore.getState().openCreate();
    const d = useAppStore.getState().createDialog;
    expect(d.custom).toEqual(r);
    expect(d.buffer).toContain("kind: Certificate\n");
    render(<CreateDialog />);
    expect(screen.queryByRole("combobox", { name: /Kind/ })).toBeNull();
    expect(screen.getByText("Certificate")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Namespace" })).toBeInTheDocument();
  });

  it("re-templates a custom kind for a new namespace; a cluster-scoped one has no namespace field", () => {
    const r = { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true };
    useAppStore.setState({ view: { name: "custom", resource: r }, connection: { ...useAppStore.getState().connection, scope: ["shop"], namespaces: ["shop", "blog"] } });
    useAppStore.getState().openCreate();
    useAppStore.getState().setCreateNamespace("blog");
    expect(useAppStore.getState().createDialog.buffer).toBe(customTemplate(r, "blog"));
    const issuer = { ...r, kind: "ClusterIssuer", plural: "clusterissuers", namespaced: false };
    useAppStore.setState({ view: { name: "custom", resource: issuer } });
    useAppStore.getState().openCreate();
    render(<CreateDialog />);
    expect(screen.queryByLabelText("Namespace")).toBeNull();
    expect((screen.getByLabelText("Manifest") as HTMLTextAreaElement).value).toBe(customTemplate(issuer, "shop"));
  });

  it("an explicitly requested kind wins over the open custom kind", () => {
    const r = { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true };
    useAppStore.setState({ view: { name: "custom", resource: r } });
    useAppStore.getState().openCreate("ConfigMap");
    expect(useAppStore.getState().createDialog).toMatchObject({ custom: null, kind: "ConfigMap", buffer: template("ConfigMap", "shop") });
  });
});
