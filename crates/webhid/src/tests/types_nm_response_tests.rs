use super::*;

#[test]
fn test_nm_response_hid_permission_serializes_as_p() {
    let resp = NmResponse {
        status: Some(200),
        ws_port: Some(31337),
        ws_nonce: Some("nonce".into()),
        wt_port: Some(4433),
        wt_cert_hash: Some("abc".into()),
        hid_permission: Some(1),
        ..Default::default()
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("\"P\":1"), "json={json}");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["P"], 1);
    assert_eq!(value["w"], 31337);
}

#[test]
fn test_nm_response_hid_permission_omitted_when_none() {
    let resp = NmResponse::ok();
    let json = serde_json::to_string(&resp).unwrap();
    assert!(!json.contains("\"P\""), "json={json}");
}
