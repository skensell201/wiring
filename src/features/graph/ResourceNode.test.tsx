import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../shared/ipc/types";
import { ResourceCard } from "./ResourceNode";

const node: GraphNode = { id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "err", badges: ["CrashLoopBackOff", "↻ 14"], group: null };

describe("ResourceCard", () => {
  it("shows kind, name, badges and a status dot", () => {
    render(<ResourceCard node={node} dimmed={false} expanded={false} selected={false} />);
    expect(screen.getByText("Pod")).toBeInTheDocument();
    expect(screen.getByText("web-1")).toBeInTheDocument();
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(screen.getByText("↻ 14")).toBeInTheDocument();
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "err");
  });

  it("renders a pod group with its count and an expand hint", () => {
    const group: GraphNode = { ...node, id: "PodGroup/p/Deployment/web", kind: "PodGroup", name: "web", badges: ["×7", "6 ok · 1 err"], group: { count: 7, ok: 6, warn: 0, err: 1 } };
    render(<ResourceCard node={group} dimmed={false} expanded={false} selected={false} />);
    expect(screen.getByText("Pods")).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
    expect(screen.getByTitle("Double-click to expand")).toBeInTheDocument();
  });

  it("dims when asked", () => {
    render(<ResourceCard node={node} dimmed expanded={false} selected={false} />);
    expect(screen.getByTestId("resource-card")).toHaveAttribute("data-dimmed", "true");
  });
});
