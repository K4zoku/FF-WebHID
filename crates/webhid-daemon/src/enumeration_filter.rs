use webhid::{Collection, DeviceFilter, DeviceInfo, EnumerateFilter};

/// Returns whether a raw hidapi entry can still match the request filters.
///
/// Vendor and product IDs are available before the report descriptor is read,
/// so this rejects impossible entries without paying the descriptor I/O cost.
pub fn matches_vid_pid(vendor_id: u16, product_id: u16, filter: &EnumerateFilter) -> bool {
    if !filter.filters.is_empty()
        && !filter
            .filters
            .iter()
            .any(|f| matches_filter_vid_pid(vendor_id, product_id, f))
    {
        return false;
    }

    !filter.exclusion_filters.iter().any(|f| {
        f.usage_page.is_none()
            && f.usage.is_none()
            && matches_filter_vid_pid(vendor_id, product_id, f)
    })
}

/// Applies the complete WebHID requestDevice filter semantics to a
/// page-visible device, after blocklist pruning has finished.
pub fn matches_device(device: &DeviceInfo, filter: &EnumerateFilter) -> bool {
    let included = filter.filters.is_empty()
        || filter
            .filters
            .iter()
            .any(|f| matches_device_filter(device, f));
    let excluded = filter
        .exclusion_filters
        .iter()
        .any(|f| matches_device_filter(device, f));
    included && !excluded
}

fn matches_filter_vid_pid(vendor_id: u16, product_id: u16, filter: &DeviceFilter) -> bool {
    filter
        .vendor_id
        .map_or(true, |id| id == u32::from(vendor_id))
        && filter
            .product_id
            .map_or(true, |id| id == u32::from(product_id))
}

fn matches_device_filter(device: &DeviceInfo, filter: &DeviceFilter) -> bool {
    if !matches_filter_vid_pid(device.vendor_id, device.product_id, filter) {
        return false;
    }
    if filter.usage_page.is_none() && filter.usage.is_none() {
        return true;
    }
    device
        .collections
        .iter()
        .any(|collection| matches_collection_usage(collection, filter))
}

fn matches_collection_usage(collection: &Collection, filter: &DeviceFilter) -> bool {
    filter.usage_page.map_or(true, |page| {
        collection
            .usage_page
            .map_or(false, |value| u32::from(value) == page)
    }) && filter.usage.map_or(true, |usage| {
        collection
            .usage
            .map_or(false, |value| u32::from(value) == usage)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> DeviceInfo {
        DeviceInfo {
            vendor_id,
            product_id,
            product_name: String::new(),
            manufacturer: None,
            serial_number: None,
            usage_page: Some(usage_page),
            usage: Some(usage),
            device_id: 1,
            identity_key: String::new(),
            collections: vec![Collection {
                collection_type: 1,
                usage_page: Some(usage_page),
                usage: Some(usage),
                children: Vec::new(),
                input_reports: Vec::new(),
                output_reports: Vec::new(),
                feature_reports: Vec::new(),
            }],
            max_input_report_size: 0,
            descriptor_parse_failed: false,
            raw_descriptor: Vec::new(),
        }
    }

    fn filter(vendor_id: Option<u16>, product_id: Option<u16>) -> DeviceFilter {
        DeviceFilter {
            vendor_id: vendor_id.map(u32::from),
            product_id: product_id.map(u32::from),
            usage_page: None,
            usage: None,
        }
    }

    #[test]
    fn prefilter_rejects_vid_pid_mismatch() {
        let query = EnumerateFilter {
            filters: vec![filter(Some(0x16c0), Some(1))],
            exclusion_filters: Vec::new(),
        };
        assert!(matches_vid_pid(0x16c0, 1, &query));
        assert!(!matches_vid_pid(0x16c0, 2, &query));
    }

    #[test]
    fn prefilter_keeps_usage_only_filters_for_deep_matching() {
        let query = EnumerateFilter {
            filters: vec![DeviceFilter {
                vendor_id: None,
                product_id: None,
                usage_page: Some(1),
                usage: Some(5),
            }],
            exclusion_filters: Vec::new(),
        };
        assert!(matches_vid_pid(1, 2, &query));
    }

    #[test]
    fn deep_matching_preserves_inclusion_and_exclusion_semantics() {
        let query = EnumerateFilter {
            filters: vec![DeviceFilter {
                vendor_id: Some(0x16c0),
                product_id: Some(1),
                usage_page: Some(1),
                usage: Some(5),
            }],
            exclusion_filters: vec![filter(Some(0x16c0), Some(2))],
        };
        assert!(matches_device(&device(0x16c0, 1, 1, 5), &query));
        assert!(!matches_device(&device(0x16c0, 1, 1, 6), &query));
        assert!(!matches_device(&device(0x16c0, 2, 1, 5), &query));
    }
}
