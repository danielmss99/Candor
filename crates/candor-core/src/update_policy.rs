use serde_json::{json, Value};

#[derive(Default)]
pub struct UpdatePolicy;

impl UpdatePolicy {
    pub fn status(&self) -> Value {
        json!({
            "implemented": true,
            "policy": "manual-check-only",
            "m0Mode": true,
            "backgroundChecks": false,
            "backgroundDownloads": false,
            "startupCheck": false,
            "manualCheckImplemented": false,
            "manualCheckNetworkEnabled": false,
            "pinnedEndpointConfigured": false,
            "attemptedChecks": 0,
            "attemptedDownloads": 0,
            "userInitiatedOnly": true,
            "networkPolicy": "disabled-by-default",
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_policy_has_no_background_networking() {
        let status = UpdatePolicy.status();

        assert_eq!(status["implemented"], true);
        assert_eq!(status["backgroundChecks"], false);
        assert_eq!(status["backgroundDownloads"], false);
        assert_eq!(status["manualCheckNetworkEnabled"], false);
        assert_eq!(status["attemptedChecks"], 0);
        assert_eq!(status["rawPathExposed"], false);
    }
}
