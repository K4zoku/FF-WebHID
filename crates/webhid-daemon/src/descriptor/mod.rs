//! HID report descriptor parser -> Chromium-shaped collections tree.

mod fields;
mod tree;

use hidreport::ReportDescriptor;
use webhid::types::{Collection, Report};

use tree::CollectionTreeBuilder;

/// Parse a raw HID report descriptor into a Chromium-shaped collections tree.
/// The error is surfaced so callers (daemon log, `dump` subcommand) can tell
/// users *why* a device's descriptor was rejected.
pub fn parse_report_descriptor(bytes: &[u8]) -> Result<Vec<Collection>, hidreport::ParserError> {
    let rdesc = ReportDescriptor::try_from(bytes)?;

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

    Ok(tree.build())
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
#[path = "../tests/descriptor/mod.rs"]
mod tests;
