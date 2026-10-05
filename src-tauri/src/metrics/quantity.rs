//! Kubernetes resource quantities as metrics-server and pod specs write them.

/// The numeric prefix and the suffix of `q`; `None` without digits or with more than one dot.
fn split(q: &str) -> Option<(f64, &str)> {
    let q = q.trim();
    let end = q.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(q.len());
    let (num, suffix) = q.split_at(end);
    if !num.bytes().any(|b| b.is_ascii_digit()) || num.matches('.').count() > 1 {
        return None;
    }
    Some((num.parse().ok()?, suffix))
}

/// `n × factor` rounded to a whole number; `None` when it does not fit a `u64`.
fn scale(n: f64, factor: f64) -> Option<u64> {
    let v = (n * factor).round();
    // 2^64 as f64 is exact; anything at or above it (or non-finite) overflows.
    (v.is_finite() && (0.0..18446744073709551616.0).contains(&v)).then_some(v as u64)
}

/// CPU in millicores: `250m`, `1`, `0.5`, `1500u`, `123456789n`.
pub fn cpu_millis(q: &str) -> Option<u64> {
    let (n, suffix) = split(q)?;
    let factor = match suffix {
        "" => 1000.0,
        "m" => 1.0,
        "u" => 1e-3,
        "n" => 1e-6,
        _ => return None,
    };
    scale(n, factor)
}

/// Memory in bytes: `64Mi`, `1Gi`, `500M`, `1048576`, `1500m` (milli-bytes).
pub fn memory_bytes(q: &str) -> Option<u64> {
    let (n, suffix) = split(q)?;
    let binary = |p: i32| 1024f64.powi(p);
    let factor = match suffix {
        "" => 1.0,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => binary(1),
        "Mi" => binary(2),
        "Gi" => binary(3),
        "Ti" => binary(4),
        "Pi" => binary(5),
        "Ei" => binary(6),
        _ => return None,
    };
    scale(n, factor)
}

/// `kubectl top` style: always millicores, so the column sorts by its leading number.
pub fn fmt_cpu(millis: u64) -> String {
    format!("{millis}m")
}

/// `kubectl top` style: always whole MiB (rounded), so the column sorts by its leading number.
pub fn fmt_memory(bytes: u64) -> String {
    format!("{}Mi", (bytes >> 20) + ((bytes >> 19) & 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_quantities_become_millicores() {
        assert_eq!(cpu_millis("250m"), Some(250));
        assert_eq!(cpu_millis("1"), Some(1000));
        assert_eq!(cpu_millis("0.5"), Some(500));
        assert_eq!(cpu_millis("2.5"), Some(2500));
        assert_eq!(cpu_millis("1500u"), Some(2));
        assert_eq!(cpu_millis("123456789n"), Some(123));
        assert_eq!(cpu_millis(" 100m "), Some(100));
        for bad in ["", "m", "abc", "1Ki", "1.2.3", "1e3", "-1", ".", ".m", "+1", "inf", "NaN"] {
            assert_eq!(cpu_millis(bad), None, "{bad}");
        }
    }

    #[test]
    fn memory_quantities_become_bytes() {
        assert_eq!(memory_bytes("1048576"), Some(1 << 20));
        assert_eq!(memory_bytes("64Mi"), Some(64 << 20));
        assert_eq!(memory_bytes("1Gi"), Some(1 << 30));
        assert_eq!(memory_bytes("1536Ki"), Some(1536 << 10));
        assert_eq!(memory_bytes("1Ti"), Some(1 << 40));
        assert_eq!(memory_bytes("500M"), Some(500_000_000));
        assert_eq!(memory_bytes("2k"), Some(2000));
        assert_eq!(memory_bytes("1G"), Some(1_000_000_000));
        assert_eq!(memory_bytes("1500m"), Some(2));
        assert_eq!(memory_bytes("0.5Gi"), Some(1 << 29));
        assert_eq!(memory_bytes("1Pi"), Some(1 << 50));
        assert_eq!(memory_bytes("1Ei"), Some(1 << 60));
        assert_eq!(memory_bytes("1T"), Some(1_000_000_000_000));
        assert_eq!(memory_bytes("1P"), Some(1_000_000_000_000_000));
        assert_eq!(memory_bytes("1E"), Some(1_000_000_000_000_000_000));
        assert_eq!(memory_bytes("0"), Some(0));
        for bad in [
            "", "Mi", "abc", "1MB", "1.2.3", "1e3", "-1Mi", "1 Mi", "1mi", "1K", "1Mi5", ".", "1Ki.",
        ] {
            assert_eq!(memory_bytes(bad), None, "{bad}");
        }
    }

    #[test]
    fn overflowing_quantities_are_none_not_wrapped() {
        assert_eq!(memory_bytes("16Ei"), None);
        assert_eq!(memory_bytes("99999999999999999999Ei"), None);
        assert_eq!(memory_bytes(&format!("{}Ei", "9".repeat(400))), None);
        assert_eq!(memory_bytes(&"9".repeat(400)), None);
        assert_eq!(cpu_millis(&"9".repeat(400)), None);
        assert_eq!(cpu_millis("18446744073709551615m"), None); // rounds up to 2^64 as f64
        assert_eq!(cpu_millis("99999999999999999999m"), None);
        assert_eq!(cpu_millis("1000000000000000"), Some(1_000_000_000_000_000_000));
    }

    #[test]
    fn values_print_like_kubectl_top() {
        assert_eq!(fmt_cpu(120), "120m");
        assert_eq!(fmt_cpu(1500), "1500m");
        assert_eq!(fmt_memory(64 << 20), "64Mi");
        assert_eq!(fmt_memory(0), "0Mi");
        assert_eq!(fmt_memory((64 << 20) + (1 << 19)), "65Mi");
        assert_eq!(fmt_memory((64 << 20) + (1 << 19) - 1), "64Mi");
        assert_eq!(fmt_memory(1 << 30), "1024Mi");
        assert_eq!(fmt_memory(u64::MAX), "17592186044416Mi");
    }
}
