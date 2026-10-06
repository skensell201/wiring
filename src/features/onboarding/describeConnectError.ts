import type { AppError } from "../../shared/ipc/types";

export type ConnectCause = "helper" | "credentials" | "certificate" | "timeout" | "unreachable" | "other";

/** A failed connect in words: the title of the failure pane, the server's first line, a next step. */
export interface ConnectErrorInfo { cause: ConnectCause; title: string; detail: string; hint: string | null }

/** The backend appends this to every `auth` error of a context with an exec plugin. */
const PLUGIN = /\(exec plugin: ([^)]+)\)/;
/**
 * kube-client's `AuthExecStart` ("unable to run auth exec: <io error>") means the plugin could not be
 * spawned; a plugin that ran and failed reads "auth exec command '…' failed with status …" instead.
 * Only a not-found io error means "not installed" (Unix, Windows, and Rust's own wording).
 */
const NOT_FOUND = ["no such file or directory", "cannot find the file", "cannot find the path", "program not found", "os error [23]\\b"];
const NOT_STARTED = new RegExp(`unable to run auth exec: .*(${NOT_FOUND.join("|")})`, "i");
const NOT_RUNNABLE = /unable to run auth exec: .*(permission denied|os error 13\b)/i;
/** rustls ("invalid peer certificate: UnknownIssuer | Expired | NotValidForName …"), OpenSSL and Go wording. */
const CERTIFICATE = /invalid peer certificate|certificate verify failed|x509|unknownissuer|certexpired|notvalidforname|certificate (?:has expired|is not valid|signed by unknown)/i;
const TIMED_OUT = /timed out/i;
const RESTART = "Wiring uses your login shell's PATH; restart Wiring after installing it.";
const NETWORK_HINT = "Check your VPN or network.";
const INSTALL: Record<string, string> = {
  "gke-gcloud-auth-plugin": "Install it with: gcloud components install gke-gcloud-auth-plugin.",
  aws: "Install the AWS CLI.",
  kubelogin: "Install it with: brew install Azure/kubelogin/kubelogin.",
};

const firstLine = (s: string) => s.split("\n", 1)[0].trim();

/** Why `connect` failed, classified from the `AppError` alone (pure). */
export function describeConnectError(error: AppError): ConnectErrorInfo {
  const detail = firstLine(error.message);
  if (error.kind === "auth") {
    const plugin = PLUGIN.exec(error.message)?.[1].trim();
    const name = plugin && (plugin.split(/[\\/]/).pop() || plugin);
    if (plugin && name && NOT_RUNNABLE.test(error.message)) {
      return { cause: "helper", title: `The ${name} login helper can't be run`, detail, hint: "Check that the file is executable, then Retry." };
    }
    if (plugin && name && NOT_STARTED.test(error.message)) {
      const install = INSTALL[name] ?? `Install ${name} and make sure it is on your PATH.`;
      return { cause: "helper", title: `The ${name} login helper isn't installed`, detail, hint: `${install} ${RESTART}` };
    }
    const hint = name ? `Sign in again with ${name}, then Retry.` : "Check the token or client certificate in your kubeconfig, then Retry.";
    return { cause: "credentials", title: "The cluster didn't accept your credentials", detail, hint };
  }
  if (error.kind === "network" && TIMED_OUT.test(error.message)) {
    return { cause: "timeout", title: "Connection timed out", detail, hint: NETWORK_HINT };
  }
  if ((error.kind === "network" || error.kind === "internal") && CERTIFICATE.test(error.message)) {
    return { cause: "certificate", title: "The cluster's certificate isn't trusted", detail, hint: "Check the cluster's CA in your kubeconfig." };
  }
  if (error.kind === "network") return { cause: "unreachable", title: "Can't reach the cluster", detail, hint: NETWORK_HINT };
  return { cause: "other", title: "Couldn't connect", detail, hint: null };
}
