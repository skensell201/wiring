import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import { ActionDialogs } from "../actions/ActionDialogs";

const SVC = "Service/p/web";
type Args = Record<string, unknown> | undefined;
let ports: { port: number; label: string }[] = [];

beforeEach(() => {
  useAppStore.setState(initialState());
  ports = [{ port: 80, label: "80 → http (web)" }, { port: 443, label: "443 → 443" }];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args: Args) => {
    if (cmd === "forward_ports") return ports;
    if (cmd === "suggest_local_port") return (args!.port as number) < 1024 ? 8080 : (args!.port as number);
    if (cmd === "start_forward") {
      if (args!.localPort === 9999) throw { kind: "conflict", message: "port 9999 is already in use" };
      return { id: 1, nodeId: args!.nodeId, targetLabel: "Service web", remotePort: args!.remotePort, localPort: args!.localPort, pod: "web-1", status: "active", message: null };
    }
    return null;
  }) as typeof invoke);
});

const open = (nodeId = SVC) => {
  useAppStore.setState({ actionDialog: { type: "forward", nodeId } });
  render(<ActionDialogs />);
};
const local = () => screen.getByLabelText("Local port") as HTMLInputElement;

describe("ForwardDialog", () => {
  it("offers the target's ports and prefills a free local port", async () => {
    open();
    expect(screen.getByRole("heading", { name: "Port-forward Service web" })).toBeInTheDocument();
    await waitFor(() => expect(local().value).toBe("8080"));
    const remote = screen.getByLabelText("Remote port") as HTMLSelectElement;
    expect([...remote.options].map((o) => o.textContent)).toEqual(["80 → http (web)", "443 → 443"]);
    fireEvent.change(remote, { target: { value: "443" } });
    await waitFor(() => expect(local().value).toBe("8080")); // 443 < 1024 → 8080 again
  });

  it("Start forwards and closes the dialog", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(useAppStore.getState().actionDialog).toBeNull());
    expect(invoke).toHaveBeenCalledWith("start_forward", { nodeId: SVC, remotePort: 80, localPort: 8080 });
  });

  it("a port in use is shown in the dialog, which stays open", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    fireEvent.change(local(), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("port 9999 is already in use");
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: SVC });
  });

  it("privileged or out-of-range local ports cannot be started", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    for (const v of ["80", "70000", ""]) {
      fireEvent.change(local(), { target: { value: v } });
      expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    }
  });

  it("a workload without declared ports takes a remote port by hand", async () => {
    ports = [];
    open("Deployment/p/api");
    const remote = (await screen.findByLabelText("Remote port")) as HTMLInputElement;
    expect(remote.tagName).toBe("INPUT");
    fireEvent.change(remote, { target: { value: "3000" } });
    await waitFor(() => expect(local().value).toBe("3000"));
  });

  it("a Service without TCP ports says so", async () => {
    ports = [];
    open();
    expect(await screen.findByText("This Service has no TCP ports.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("Cancel closes without forwarding", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("start_forward", expect.anything());
  });
});
