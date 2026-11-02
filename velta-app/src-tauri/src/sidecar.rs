//! Sidecar JSON-RPC line routing (#201).
//!
//! Parse each stdout line once and route on the *envelope* `id`. A nested
//! object that happens to carry `"id"` must not steal the dispatch.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// Envelope id starts with `wxdc-`.
    Webxdc,
    /// Envelope has some other id — try `resolve_web_line`, else emit.
    Web,
    /// No envelope id, or the line is not JSON: emit as `velta-rpc`.
    Emit,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    id: Option<serde_json::Value>,
}

pub(crate) fn route_sidecar_line(line: &str) -> Route {
    let Ok(env) = serde_json::from_str::<Envelope>(line) else {
        return Route::Emit;
    };
    match env.id {
        Some(serde_json::Value::String(id)) if id.starts_with("wxdc-") => Route::Webxdc,
        Some(_) => Route::Web,
        None => Route::Emit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_id_is_not_the_envelope_id() {
        let nested_wxdc = r#"{"jsonrpc":"2.0","id":"web-1","result":{"id":"wxdc-nested","foo":1}}"#;
        assert_eq!(
            route_sidecar_line(nested_wxdc),
            Route::Web,
            "top-level id wins; nested wxdc- must not route as webxdc"
        );

        let top_wxdc = r#"{"jsonrpc":"2.0","id":"wxdc-abc","result":{"id":"other"}}"#;
        assert_eq!(route_sidecar_line(top_wxdc), Route::Webxdc);

        let nested_only = r#"{"jsonrpc":"2.0","method":"event","params":{"id":"wxdc-nested"}}"#;
        assert_eq!(
            route_sidecar_line(nested_only),
            Route::Emit,
            "no top-level id → emit, even if a nested id looks like wxdc-"
        );
    }

    #[test]
    fn malformed_json_is_still_emitted() {
        assert_eq!(route_sidecar_line("not json"), Route::Emit);
        assert_eq!(route_sidecar_line(""), Route::Emit);
        assert_eq!(route_sidecar_line("{"), Route::Emit);
    }

    #[test]
    fn numeric_and_null_ids() {
        assert_eq!(route_sidecar_line(r#"{"id":1,"result":{}}"#), Route::Web);
        assert_eq!(
            route_sidecar_line(r#"{"id":null,"result":{}}"#),
            Route::Emit
        );
        assert_eq!(route_sidecar_line(r#"{"result":{}}"#), Route::Emit);
    }
}
