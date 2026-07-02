use wasm_bindgen::prelude::*;
use hidreport::{ReportDescriptor, Field, FieldAttributes, Report};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
struct WebHidCollection {
    #[serde(rename = "type")]
    collection_type: u8,
    usage_page: Option<u16>,
    usage: Option<u16>,
    children: Vec<WebHidCollection>,
    input_reports: Vec<WebHidReport>,
    output_reports: Vec<WebHidReport>,
    feature_reports: Vec<WebHidReport>,
}

#[derive(Serialize, Clone)]
struct WebHidReport {
    report_id: Option<u8>,
    items: Vec<WebHidField>,
}

#[derive(Serialize, Clone)]
struct WebHidField {
    usage_page: Option<u16>,
    usages: Vec<u16>,
    logical_minimum: Option<i32>,
    logical_maximum: Option<i32>,
    physical_minimum: Option<i32>,
    physical_maximum: Option<i32>,
    unit_exponent: Option<i32>,
    unit: Option<u32>,
    is_absolute: bool,
    is_array: bool,
    is_range: bool,
    report_id: Option<u8>,
    report_type: String,
}

#[wasm_bindgen]
pub fn parse_descriptor(bytes: &[u8]) -> JsValue {
    let rdesc = match ReportDescriptor::try_from(bytes) {
        Ok(d) => d,
        Err(_) => return JsValue::NULL,
    };

    let mut tree = CollectionTreeBuilder::new();

    for report in rdesc.input_reports() {
        let rid = report.report_id().map(|id| id.into());
        let items: Vec<WebHidField> = report.fields().iter().map(|f| convert_field(f, rid, "input")).collect();
        tree.add_report(report, "input", WebHidReport { report_id: rid, items });
    }
    for report in rdesc.output_reports() {
        let rid = report.report_id().map(|id| id.into());
        let items: Vec<WebHidField> = report.fields().iter().map(|f| convert_field(f, rid, "output")).collect();
        tree.add_report(report, "output", WebHidReport { report_id: rid, items });
    }
    for report in rdesc.feature_reports() {
        let rid = report.report_id().map(|id| id.into());
        let items: Vec<WebHidField> = report.fields().iter().map(|f| convert_field(f, rid, "feature")).collect();
        tree.add_report(report, "feature", WebHidReport { report_id: rid, items });
    }

    let collections = tree.build();
    serde_wasm_bindgen::to_value(&collections).unwrap_or(JsValue::NULL)
}

fn convert_field(field: &Field, report_id: Option<u8>, report_type: &str) -> WebHidField {
    match field {
        Field::Variable(v) => {
            let page: u16 = v.usage.usage_page.into();
            let uid: u16 = v.usage.usage_id.into();
            WebHidField {
                usage_page: Some(page),
                usages: vec![uid],
                logical_minimum: Some(v.logical_minimum.into()),
                logical_maximum: Some(v.logical_maximum.into()),
                physical_minimum: v.physical_minimum.map(|x| x.into()),
                physical_maximum: v.physical_maximum.map(|x| x.into()),
                unit_exponent: v.unit_exponent.map(|x| x.into()),
                unit: v.unit.map(|x| x.into()),
                is_absolute: v.is_absolute(),
                is_array: false,
                is_range: false,
                report_id,
                report_type: report_type.to_string(),
            }
        }
        Field::Array(a) => {
            let usages: Vec<u16> = if a.is_usage_range() {
                a.usage_range().map(|r| {
                    let lo: u16 = r.minimum().usage_id().into();
                    let hi: u16 = r.maximum().usage_id().into();
                    (lo..=hi).collect()
                }).unwrap_or_default()
            } else {
                a.usages().iter().map(|u| u.usage_id.into()).collect()
            };
            WebHidField {
                usage_page: a.usages().first().map(|u| u.usage_page.into()),
                usages,
                logical_minimum: Some(a.logical_minimum.into()),
                logical_maximum: Some(a.logical_maximum.into()),
                physical_minimum: a.physical_minimum.map(|x| x.into()),
                physical_maximum: a.physical_maximum.map(|x| x.into()),
                unit_exponent: a.unit_exponent.map(|x| x.into()),
                unit: a.unit.map(|x| x.into()),
                is_absolute: true,
                is_array: true,
                is_range: a.is_usage_range(),
                report_id,
                report_type: report_type.to_string(),
            }
        }
        Field::Constant(_) => WebHidField {
            usage_page: None, usages: vec![], logical_minimum: None, logical_maximum: None,
            physical_minimum: None, physical_maximum: None, unit_exponent: None, unit: None,
            is_absolute: false, is_array: false, is_range: false,
            report_id, report_type: report_type.to_string(),
        },
    }
}

struct ColNode {
    collection_type: u8,
    usage_page: Option<u16>,
    usage: Option<u16>,
    children: Vec<String>,
    input_reports: Vec<WebHidReport>,
    output_reports: Vec<WebHidReport>,
    feature_reports: Vec<WebHidReport>,
}

struct CollectionTreeBuilder {
    nodes: HashMap<String, ColNode>,
    root_ids: Vec<String>,
}

impl CollectionTreeBuilder {
    fn new() -> Self { Self { nodes: HashMap::new(), root_ids: Vec::new() } }

    fn add_report(&mut self, report: &impl Report, rtype: &str, web_report: WebHidReport) {
        if let Some(first_field) = report.fields().first() {
            let chain = first_field.collections();
            for (i, col) in chain.iter().enumerate() {
                let id_str = format!("{:?}", col.id());
                if !self.nodes.contains_key(&id_str) {
                    if i == 0 { self.root_ids.push(id_str.clone()); }
                    if i > 0 {
                        let pid = format!("{:?}", chain[i-1].id());
                        self.nodes.entry(pid).and_modify(|p| {
                            if !p.children.contains(&id_str) { p.children.push(id_str.clone()); }
                        });
                    }
                    self.nodes.insert(id_str.clone(), ColNode {
                        collection_type: col.collection_type().into(),
                        usage_page: col.usages().first().map(|u| u.usage_page.into()),
                        usage: col.usages().first().map(|u| u.usage_id.into()),
                        children: Vec::new(),
                        input_reports: Vec::new(),
                        output_reports: Vec::new(),
                        feature_reports: Vec::new(),
                    });
                }
            }
            if let Some(last) = chain.last() {
                let lid = format!("{:?}", last.id());
                if let Some(n) = self.nodes.get_mut(&lid) {
                    match rtype { "input" => n.input_reports.push(web_report), "output" => n.output_reports.push(web_report), "feature" => n.feature_reports.push(web_report), _ => {} }
                }
            }
        }
    }

    fn build(self) -> Vec<WebHidCollection> {
        let mut result = Vec::new();
        for rid in &self.root_ids {
            if let Some(r) = self.build_node(rid) { result.push(r); }
        }
        if result.is_empty() {
            result.push(WebHidCollection { collection_type: 1, usage_page: None, usage: None, children: vec![], input_reports: vec![], output_reports: vec![], feature_reports: vec![] });
        }
        result
    }

    fn build_node(&self, id: &str) -> Option<WebHidCollection> {
        let n = self.nodes.get(id)?;
        Some(WebHidCollection {
            collection_type: n.collection_type, usage_page: n.usage_page, usage: n.usage,
            children: n.children.iter().filter_map(|c| self.build_node(c)).collect(),
            input_reports: n.input_reports.clone(), output_reports: n.output_reports.clone(), feature_reports: n.feature_reports.clone(),
        })
    }
}
