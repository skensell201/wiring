use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Auth,
    Network,
    Forbidden,
    NotFound,
    /// The write lost a resourceVersion race (HTTP 409).
    Conflict,
    /// The server rejected the manifest (HTTP 400/422); the message lists the bad fields.
    Invalid,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{kind:?}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Map a Kubernetes API status code to an `ErrorKind`.
pub fn from_status(code: u16, message: &str) -> AppError {
    let kind = match code {
        401 => ErrorKind::Auth,
        403 => ErrorKind::Forbidden,
        404 => ErrorKind::NotFound,
        409 => ErrorKind::Conflict,
        400 | 422 => ErrorKind::Invalid,
        _ => ErrorKind::Internal,
    };
    AppError::new(kind, message)
}

impl From<&kube::Error> for AppError {
    fn from(e: &kube::Error) -> Self {
        match e {
            kube::Error::Api(resp) => from_status(resp.code, &resp.message),
            kube::Error::Auth(e) => AppError::new(ErrorKind::Auth, e.to_string()),
            kube::Error::HyperError(_) | kube::Error::Service(_) => AppError::new(ErrorKind::Network, e.to_string()),
            other => AppError::new(ErrorKind::Internal, other.to_string()),
        }
    }
}

/// Map a kubeconfig-loading error to an `ErrorKind` by variant, rather than lumping everything
/// under `Auth`. These variants never embed raw file content, so `e.to_string()` is safe to
/// show as-is.
impl From<&kube::config::KubeconfigError> for AppError {
    fn from(e: &kube::config::KubeconfigError) -> Self {
        use kube::config::KubeconfigError;
        let kind = match e {
            // Context/cluster could not be found by name.
            KubeconfigError::CurrentContextNotSet | KubeconfigError::LoadContext(_) | KubeconfigError::LoadClusterOfContext(_) => {
                ErrorKind::NotFound
            }
            // Cert/key loading and parsing — these are what actually authenticate the client.
            KubeconfigError::LoadCertificateAuthority(_)
            | KubeconfigError::LoadClientCertificate(_)
            | KubeconfigError::LoadClientKey(_)
            | KubeconfigError::ParseCertificates(_) => ErrorKind::Auth,
            // Everything else: malformed/unreadable kubeconfig data or config shape issues.
            KubeconfigError::KindMismatch
            | KubeconfigError::ApiVersionMismatch
            | KubeconfigError::FindPath
            | KubeconfigError::ReadConfig(..)
            | KubeconfigError::Parse(_)
            | KubeconfigError::MissingClusterUrl
            | KubeconfigError::ParseClusterUrl(_)
            | KubeconfigError::ParseProxyUrl(_) => ErrorKind::Internal,
        };
        AppError::new(kind, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_from_kube_maps_status_codes() {
        let case = |code: u16, expected: ErrorKind| {
            let status = kube::core::Status {
                code,
                message: "x".into(),
                reason: "y".into(),
                ..Default::default()
            };
            let err = kube::Error::Api(Box::new(status));
            assert_eq!(AppError::from(&err).kind, expected, "code {code}");
        };
        case(401, ErrorKind::Auth);
        case(403, ErrorKind::Forbidden);
        case(404, ErrorKind::NotFound);
        case(409, ErrorKind::Conflict);
        case(400, ErrorKind::Invalid);
        case(422, ErrorKind::Invalid);
        case(500, ErrorKind::Internal);
        // kube::Error::HyperError / ::Service wrap hyper::Error / tower::BoxError, which have
        // no public constructor for a synthetic instance outside of a real transport failure,
        // so the Network-mapping branch isn't covered by a standalone case here.
    }

    #[test]
    fn error_kinds_serialize_as_camel_case() {
        assert_eq!(serde_json::to_string(&ErrorKind::Conflict).unwrap(), "\"conflict\"");
        assert_eq!(serde_json::to_string(&ErrorKind::Invalid).unwrap(), "\"invalid\"");
        assert_eq!(serde_json::to_string(&ErrorKind::NotFound).unwrap(), "\"notFound\"");
    }
}
