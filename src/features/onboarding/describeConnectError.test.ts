import { describe, expect, it } from "vitest";
import type { AppError } from "../../shared/ipc/types";
import { describeConnectError } from "./describeConnectError";

const RESTART = "Wiring uses your login shell's PATH; restart Wiring after installing it.";
const err = (kind: AppError["kind"], message: string): AppError => ({ kind, message });
// kube-client 4.2 `AuthExecStart` ("unable to run auth exec: {io error}") plus the backend's plugin suffix.
const missing = (plugin: string) => err("auth", `unable to run auth exec: No such file or directory (os error 2) (exec plugin: ${plugin})`);

describe("describeConnectError", () => {
  it("names a missing login helper, by its file name, with how to install it", () => {
    const m = missing("/usr/local/bin/gke-gcloud-auth-plugin");
    expect(describeConnectError(m)).toEqual({
      cause: "helper",
      title: "The gke-gcloud-auth-plugin login helper isn't installed",
      detail: m.message,
      hint: `Install it with: gcloud components install gke-gcloud-auth-plugin. ${RESTART}`,
    });
  });

  it("recognises a missing helper on Windows paths and messages", () => {
    const m = err("auth", "unable to run auth exec: The system cannot find the file specified. (os error 2) (exec plugin: C:\\bin\\aws.exe)");
    expect(describeConnectError(m)).toMatchObject({ cause: "helper", title: "The aws.exe login helper isn't installed" });
  });

  it.each([
    ["aws", "Install the AWS CLI."],
    ["kubelogin", "Install it with: brew install Azure/kubelogin/kubelogin."],
    ["tsh", "Install tsh and make sure it is on your PATH."],
  ])("gives an install hint for %s", (plugin, install) => {
    expect(describeConnectError(missing(plugin)).hint).toBe(`${install} ${RESTART}`);
  });

  it("treats other auth failures as rejected credentials, with or without a plugin", () => {
    for (const e of [err("auth", "Unauthorized (exec plugin: aws)"), err("auth", "Unauthorized")]) {
      expect(describeConnectError(e)).toMatchObject({
        cause: "credentials", title: "Your credentials were rejected", hint: "Log in again with your provider's CLI, then Retry.",
      });
    }
  });

  it("does not call a plugin that ran and failed uninstalled", () => {
    for (const message of [
      "auth exec command 'aws' failed with status exit status: 255: Output { stderr: \"The config profile (x) could not be found\" } (exec plugin: aws)",
      "auth exec command 'aws' failed with status exit status: 1: profile not found (exec plugin: aws)",
      "unable to run auth exec: Permission denied (os error 13) (exec plugin: aws)",
    ]) {
      expect(describeConnectError(err("auth", message)).cause).toBe("credentials");
    }
  });

  it.each([
    "error trying to connect: invalid peer certificate: UnknownIssuer",
    "error trying to connect: invalid peer certificate: Expired",
    "error trying to connect: invalid peer certificate: NotValidForName",
    "error trying to connect: invalid peer certificate: ExpiredContext { time: UnixTime(1), not_after: UnixTime(0) }",
    "x509: certificate signed by unknown authority",
  ])("recognises an untrusted certificate: %s", (message) => {
    for (const kind of ["network", "internal"] as const) {
      expect(describeConnectError(err(kind, message))).toMatchObject({
        cause: "certificate", title: "The cluster's certificate isn't trusted", hint: "Check the cluster's CA in your kubeconfig.",
      });
    }
  });

  it("recognises a timeout before certificate words in the server name", () => {
    expect(describeConnectError(err("network", "timed out after 20 s waiting for https://ssl.example.com"))).toMatchObject({
      cause: "timeout", title: "Connection timed out", hint: "Check your VPN or network.",
    });
  });

  it("does not mistake a server name for a certificate problem", () => {
    expect(describeConnectError(err("network", "error trying to connect: tcp connect error: Connection refused (os error 61) https://ssl.example.com"))).toMatchObject({
      cause: "unreachable",
    });
  });

  it("calls any other network error unreachable", () => {
    expect(describeConnectError(err("network", "error trying to connect: tcp connect error: Connection refused (os error 61)"))).toMatchObject({
      cause: "unreachable", title: "Can't reach the cluster", hint: "Check your VPN or network.",
    });
  });

  it("falls back to the message alone", () => {
    expect(describeConnectError(err("notFound", 'context "x" not found'))).toEqual({
      cause: "other", title: "Couldn't connect", detail: 'context "x" not found', hint: null,
    });
  });

  it("keeps only the first line of the server's message", () => {
    expect(describeConnectError(err("network", "refused\nsecond line")).detail).toBe("refused");
  });
});
