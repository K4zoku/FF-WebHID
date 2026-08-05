//! Collection tree builder: chains of hidreport collections -> Chromium-shaped
//! Collection tree with reports attached to their innermost collection.

use std::collections::HashMap;

use hidreport::{Collection as HidCollection, Field};

use webhid::types::{Collection, Report};

use super::fields::convert_fields_aggregate;

struct ColNode {
    collection_type: u8,
    usage_page: Option<u16>,
    usage: Option<u16>,
    children: Vec<String>,
    input_reports: Vec<Report>,
    output_reports: Vec<Report>,
    feature_reports: Vec<Report>,
}

pub(super) struct CollectionTreeBuilder {
    nodes: HashMap<String, ColNode>,
    root_ids: Vec<String>,
}

impl CollectionTreeBuilder {
    pub(super) fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            root_ids: Vec::new(),
        }
    }

    fn col_key(c: &HidCollection) -> String {
        format!("{:?}", c.id())
    }

    fn ensure_chain(&mut self, chain: &[HidCollection]) {
        for (i, col) in chain.iter().enumerate() {
            let id_str = Self::col_key(col);
            if !self.nodes.contains_key(&id_str) {
                if i == 0 {
                    self.root_ids.push(id_str.clone());
                }
                if i > 0 {
                    let pid = Self::col_key(&chain[i - 1]);
                    if let Some(p) = self.nodes.get_mut(&pid)
                        && !p.children.contains(&id_str)
                    {
                        p.children.push(id_str.clone());
                    }
                }
                let collection_type: u8 = col.collection_type().into();
                let usage_page = col.usages().first().map(|u| u.usage_page.into());
                let usage = col.usages().first().map(|u| u.usage_id.into());
                self.nodes.insert(
                    id_str,
                    ColNode {
                        collection_type,
                        usage_page,
                        usage,
                        children: Vec::new(),
                        input_reports: Vec::new(),
                        output_reports: Vec::new(),
                        feature_reports: Vec::new(),
                    },
                );
            }
        }
    }

    pub(super) fn add_report(&mut self, report: &impl hidreport::Report, rtype: &str) {
        let rid: u8 = report
            .report_id()
            .as_ref()
            .map(|id| (*id).into())
            .unwrap_or(0);
        let items = convert_fields_aggregate(report.fields());

        if items.is_empty() {
            return;
        }

        let web_report = Report {
            report_id: rid,
            items,
        };

        let chain: &[HidCollection] = report
            .fields()
            .iter()
            .find_map(|f| match f {
                Field::Variable(_) | Field::Array(_) => Some(f.collections()),
                _ => None,
            })
            .unwrap_or(&[]);

        if chain.is_empty() {
            return;
        }

        self.ensure_chain(chain);

        if let Some(last) = chain.last() {
            let lid = Self::col_key(last);
            if let Some(n) = self.nodes.get_mut(&lid) {
                match rtype {
                    "input" => n.input_reports.push(web_report),
                    "output" => n.output_reports.push(web_report),
                    "feature" => n.feature_reports.push(web_report),
                    _ => {}
                }
            }
        }
    }

    pub(super) fn build(self) -> Vec<Collection> {
        let mut result = Vec::new();
        for rid in &self.root_ids {
            if let Some(r) = self.build_node(rid) {
                result.push(r);
            }
        }
        if result.is_empty() {
            result.push(Collection {
                collection_type: 1,
                usage_page: None,
                usage: None,
                children: vec![],
                input_reports: vec![],
                output_reports: vec![],
                feature_reports: vec![],
            });
        }
        result
    }

    fn build_node(&self, id: &str) -> Option<Collection> {
        let n = self.nodes.get(id)?;
        Some(Collection {
            collection_type: n.collection_type,
            usage_page: n.usage_page,
            usage: n.usage,
            children: n
                .children
                .iter()
                .filter_map(|c| self.build_node(c))
                .collect(),
            input_reports: n.input_reports.clone(),
            output_reports: n.output_reports.clone(),
            feature_reports: n.feature_reports.clone(),
        })
    }
}
