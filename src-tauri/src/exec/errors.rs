//! What a failed or finished exec means to the user (spec §3 "Errors", §4 exit code). Pure.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;

use crate::error::AppError;

pub const FORBIDDEN: &str = "No permission to exec into pods (pods/exec)";
pub const NO_SHELL: &str = "This container has no shell (distroless image?)";

pub fn is_no_shell(message: &str) -> bool {
    message.contains("executable file not found")
}

/// The message for a websocket that could not be opened. A refused upgrade surfaces as
/// `ProtocolSwitch(status)`, not as an API error (same as `forward::kube`).
pub fn start_error(e: &kube::Error) -> String {
    use kube::client::UpgradeConnectionError::ProtocolSwitch;
    match e {
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) if *status == http::StatusCode::FORBIDDEN => FORBIDDEN.into(),
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) => format!("exec refused: {status}"),
        kube::Error::Api(resp) if resp.code == 403 => FORBIDDEN.into(),
        _ => {
            let message = AppError::from(e).message;
            if is_no_shell(&message) {
                NO_SHELL.into()
            } else {
                message
            }
        }
    }
}

fn exit_code(s: &Status) -> Option<i32> {
    s.details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|c| c.reason.as_deref() == Some("ExitCode"))?
        .message
        .as_ref()?
        .parse()
        .ok()
}

/// `(exit code, message)` for the `ended` message from the status channel. A plain non-zero
/// exit carries only its code; a missing shell gets `NO_SHELL`; anything else keeps the
/// server's message.
pub fn ended(status: Option<&Status>) -> (Option<i32>, Option<String>) {
    let Some(s) = status else { return (None, None) };
    if s.status.as_deref() == Some("Success") {
        return (Some(0), None);
    }
    let message = s.message.clone().unwrap_or_default();
    if is_no_shell(&message) {
        return (exit_code(s), Some(NO_SHELL.into()));
    }
    match exit_code(s) {
        Some(code) => (Some(code), None),
        None => (None, (!message.is_empty()).then_some(message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    fn failure(message: &str, exit: Option<&str>) -> Status {
        Status {
            status: Some("Failure".into()),
            message: Some(message.into()),
            reason: Some("NonZeroExitCode".into()),
            details: exit.map(|code| StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some(code.into()),
                    field: None,
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_forbidden_upgrade_names_the_missing_permission() {
        let e = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::FORBIDDEN));
        assert_eq!(start_error(&e), FORBIDDEN);
        let api = kube::Error::Api(Box::new(kube::core::Status::failure("no", "Forbidden").with_code(403)));
        assert_eq!(start_error(&api), FORBIDDEN);
        let other = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::BAD_GATEWAY));
        assert!(start_error(&other).contains("502"));
    }

    #[test]
    fn success_is_exit_code_zero() {
        let ok = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        assert_eq!(ended(Some(&ok)), (Some(0), None));
        assert_eq!(ended(None), (None, None));
    }

    #[test]
    fn a_non_zero_exit_reports_only_the_code() {
        assert_eq!(
            ended(Some(&failure("command terminated with non-zero exit code: 3", Some("3")))),
            (Some(3), None)
        );
    }

    #[test]
    fn a_missing_shell_says_so() {
        let s = failure(r#"exec: "sh": executable file not found in $PATH: unknown"#, None);
        assert_eq!(ended(Some(&s)), (None, Some(NO_SHELL.to_string())));
        assert!(is_no_shell(
            r#"OCI runtime exec failed: exec: "sh": executable file not found in $PATH"#
        ));
    }

    #[test]
    fn other_failures_keep_the_server_message() {
        let s = failure("container not running", None);
        assert_eq!(ended(Some(&s)), (None, Some("container not running".to_string())));
    }
}
