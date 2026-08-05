//! HID report descriptor parser -> Chromium-shaped collections tree.

mod fields;
mod tree;

use hidreport::ReportDescriptor;
use webhid::types::{Collection, Report};

use tree::CollectionTreeBuilder;

/// Parse a raw HID report descriptor into a Chromium-shaped collections tree.
pub fn parse_report_descriptor(bytes: &[u8]) -> Vec<Collection> {
    let rdesc = match ReportDescriptor::try_from(bytes) {
        Ok(d) => d,
        Err(_) => {
            log::warn!("failed to parse report descriptor ({} bytes)", bytes.len());
            return vec![];
        }
    };

    let mut tree = CollectionTreeBuilder::new();
    for report in rdesc.input_reports() {
        tree.add_report(report, "input");
    }
    for report in rdesc.output_reports() {
        tree.add_report(report, "output");
    }
    for report in rdesc.feature_reports() {
        tree.add_report(report, "feature");
    }

    tree.build()
}

/// Maximum report payload size in bytes across all collections of one
/// direction. Returns 0 if none. Mirrors Chromium's max input/output/feature
/// report sizes, which are computed from the full (unpruned) descriptor.
fn max_report_size<F>(collections: &[Collection], reports: &F) -> u32
where
    F: Fn(&Collection) -> &Vec<Report>,
{
    fn visit<F>(collections: &[Collection], reports: &F) -> u32
    where
        F: Fn(&Collection) -> &Vec<Report>,
    {
        let mut max = 0u32;
        for c in collections {
            for r in reports(c) {
                let bits: u32 = r
                    .items
                    .iter()
                    .map(|f| f.report_size.saturating_mul(f.report_count))
                    .fold(0u32, |a, b| a.saturating_add(b));
                let bytes = bits.div_ceil(8);
                if bytes > max {
                    max = bytes;
                }
            }
            let child_max = visit(&c.children, reports);
            if child_max > max {
                max = child_max;
            }
        }
        max
    }
    visit(collections, reports)
}

/// Maximum input report payload size in bytes across all collections. Returns 0 if none.
pub fn max_input_report_size(collections: &[Collection]) -> u32 {
    max_report_size(collections, &|c| &c.input_reports)
}

/// Maximum output report payload size in bytes across all collections. Returns 0 if none.
pub fn max_output_report_size(collections: &[Collection]) -> u32 {
    max_report_size(collections, &|c| &c.output_reports)
}

/// Maximum feature report payload size in bytes across all collections. Returns 0 if none.
pub fn max_feature_report_size(collections: &[Collection]) -> u32 {
    max_report_size(collections, &|c| &c.feature_reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use webhid::types::Field as WebHidField;

    #[test]
    fn test_max_input_report_size_empty() {
        assert_eq!(max_input_report_size(&[]), 0);
    }

    #[test]
    fn test_max_input_report_size_no_input_reports() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        assert_eq!(max_input_report_size(&collections), 0);
    }

    #[test]
    fn test_max_input_report_size_single_report() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![Report {
                report_id: 0,
                items: vec![WebHidField {
                    report_size: 8,
                    report_count: 3,
                    ..Default::default()
                }],
            }],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        assert_eq!(max_input_report_size(&collections), 3);
    }

    #[test]
    fn test_max_input_report_size_multiple_reports() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![
                Report {
                    report_id: 1,
                    items: vec![WebHidField {
                        report_size: 8,
                        report_count: 1,
                        ..Default::default()
                    }],
                },
                Report {
                    report_id: 2,
                    items: vec![
                        WebHidField {
                            report_size: 8,
                            report_count: 4,
                            ..Default::default()
                        },
                        WebHidField {
                            report_size: 16,
                            report_count: 1,
                            ..Default::default()
                        },
                    ],
                },
            ],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        assert_eq!(max_input_report_size(&collections), 6);
    }

    #[test]
    fn test_max_input_report_size_nested() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![Collection {
                collection_type: 2,
                usage_page: None,
                usage: None,
                children: vec![],
                input_reports: vec![Report {
                    report_id: 0,
                    items: vec![WebHidField {
                        report_size: 64,
                        report_count: 1,
                        ..Default::default()
                    }],
                }],
                output_reports: vec![],
                feature_reports: vec![],
            }],
            input_reports: vec![],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        assert_eq!(max_input_report_size(&collections), 8);
    }

    #[test]
    fn test_max_input_report_size_overflow_does_not_panic() {
        let collections = vec![Collection {
            collection_type: 1,
            usage_page: None,
            usage: None,
            children: vec![],
            input_reports: vec![Report {
                report_id: 0,
                items: vec![WebHidField {
                    report_size: u32::MAX,
                    report_count: u32::MAX,
                    ..Default::default()
                }],
            }],
            output_reports: vec![],
            feature_reports: vec![],
        }];
        let result = max_input_report_size(&collections);
        assert!(result > 0);
    }

    #[test]
    fn test_parse_empty_descriptor() {
        let collections = parse_report_descriptor(&[]);
        assert!(collections.is_empty());
    }

    #[test]
    fn test_parse_invalid_descriptor() {
        let collections = parse_report_descriptor(&[0xFF]);
        assert!(collections.is_empty());
    }

    #[test]
    fn test_parse_valid_descriptor_with_no_reports() {
        let desc = vec![0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0xC0];
        let collections = parse_report_descriptor(&desc);
        assert!(!collections.is_empty() || desc.is_empty());
    }

    #[test]
    fn test_parse_mouse_descriptor() {
        let desc = vec![
            0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0x75, 0x08, 0x95, 0x03, 0x81, 0x02,
            0xC0,
        ];
        let collections = parse_report_descriptor(&desc);
        assert!(
            !collections.is_empty(),
            "should produce at least one collection"
        );
        let app = &collections[0];
        assert_eq!(app.collection_type, 1);
        assert_eq!(app.usage_page, Some(1));
        assert_eq!(app.usage, Some(2));
        assert!(!app.input_reports.is_empty(), "should have input reports");
        let report = &app.input_reports[0];
        assert!(!report.items.is_empty());
    }

    #[test]
    fn test_parse_descriptor_max_input_size_derived() {
        let desc = vec![
            0x05, 0x01, 0x09, 0x04, 0xA1, 0x01, 0x09, 0x01, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01,
            0x95, 0x08, 0x81, 0x02, 0x09, 0x01, 0x75, 0x08, 0x95, 0x04, 0x81, 0x02, 0xC0,
        ];
        let collections = parse_report_descriptor(&desc);
        let max = max_input_report_size(&collections);
        assert!(max >= 5, "expected at least 5 bytes, got {max}");
    }

    fn fixture_path(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .unwrap()
            .join("tests/fixtures/descriptors")
            .join(name)
    }

    fn read_edge_fixture(name: &str) -> Vec<u8> {
        let path = fixture_path("edge").join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("failed to read {path:?}: {e}"))
    }

    fn parse_edge(name: &str) -> Vec<Collection> {
        parse_report_descriptor(&read_edge_fixture(name))
    }

    #[test]
    fn test_edge_empty() {
        let c = parse_edge("empty.bin");
        assert!(c.is_empty());
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_single_byte() {
        let c = parse_edge("single-byte.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_truncated_input() {
        let c = parse_edge("truncated-input.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_truncated_long_item() {
        let c = parse_edge("truncated-long-item.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_unclosed_collection() {
        let c = parse_edge("unclosed-collection.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_extra_end_collection() {
        let c = parse_edge("extra-end-collection.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_deep_nesting() {
        let c = parse_edge("deep-nesting.bin");
        let m = max_input_report_size(&c);
        assert_eq!(m, 1);
    }

    #[test]
    fn test_edge_report_size_zero() {
        let c = parse_edge("report-size-zero.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_report_count_zero() {
        let c = parse_edge("report-count-zero.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_logical_max_ffffffff() {
        let c = parse_edge("logical-max-ffffffff.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_multiple_report_ids() {
        let c = parse_edge("multiple-report-ids.bin");
        let m = max_input_report_size(&c);
        assert!(m > 0);
    }

    #[test]
    fn test_edge_usage_page_ffff() {
        let c = parse_edge("usage-page-ffff.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_report_size_max() {
        let c = parse_edge("report-size-max.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_collection_only() {
        let c = parse_edge("collection-only.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_unit_exponent_overflow() {
        let c = parse_edge("unit-exponent-overflow.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_vendor_extended_usage() {
        let c = parse_edge("vendor-extended-usage.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_edge_valid_no_input_reports() {
        let c = parse_edge("valid-no-input-reports.bin");
        assert_eq!(max_input_report_size(&c), 0);
    }

    #[test]
    fn test_edge_variable_after_array() {
        let c = parse_edge("variable-after-array.bin");
        let _ = max_input_report_size(&c);
    }

    #[test]
    fn test_vendor_descriptor() {
        let path = fixture_path("vendor.bin");
        let bytes = std::fs::read(&path).unwrap();
        let collections = parse_report_descriptor(&bytes);
        assert_eq!(collections.len(), 2, "expected two application collections");

        let app = &collections[0];
        assert_eq!(app.collection_type, 1);

        let report_id_1 = collections
            .iter()
            .flat_map(|c| c.input_reports.iter())
            .find(|r| r.report_id == 1)
            .expect("vendor should have an input report with report_id 1");
        assert!(!report_id_1.items.is_empty(), "should have report items");

        assert_eq!(max_input_report_size(&collections), 64);
    }

    #[test]
    fn test_gamepad_descriptor() {
        let path = fixture_path("gamepad.bin");
        let bytes = std::fs::read(&path).unwrap();
        let collections = parse_report_descriptor(&bytes);
        assert_eq!(
            collections.len(),
            1,
            "should parse into exactly one collection"
        );

        let app = &collections[0];
        assert_eq!(app.collection_type, 1);
        assert_eq!(app.usage_page, Some(0x01));
        assert_eq!(app.usage, Some(0x04));

        assert!(!app.input_reports.is_empty(), "should have input reports");
        for r in &app.input_reports {
            assert_eq!(r.report_id, 0, "gamepad has numbered reports?");
        }

        assert_eq!(max_input_report_size(&collections), 5);
    }
}
