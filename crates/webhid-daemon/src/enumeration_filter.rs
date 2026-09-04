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
#[path = "tests/enumeration_filter.rs"]
mod tests;
