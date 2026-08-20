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
        let fields = report.fields();

        let chains: Vec<&[HidCollection]> = {
            let mut chains = Vec::with_capacity(fields.len());
            for (i, field) in fields.iter().enumerate() {
                let own = field.collections();
                if !own.is_empty() {
                    chains.push(own);
                    continue;
                }
                let mut resolved: Option<&[HidCollection]> = None;
                for j in (0..i).rev() {
                    if !fields[j].collections().is_empty() {
                        resolved = Some(fields[j].collections());
                        break;
                    }
                }
                if resolved.is_none() {
                    for j in (i + 1)..fields.len() {
                        if !fields[j].collections().is_empty() {
                            resolved = Some(fields[j].collections());
                            break;
                        }
                    }
                }
                chains.push(resolved.unwrap_or(&[]));
            }
            chains
        };

        let mut buckets: Vec<(String, Vec<Field>)> = Vec::new();
        let mut bucket_index: HashMap<String, usize> = HashMap::new();
        for (field, chain) in fields.iter().zip(chains.iter()) {
            let Some(last) = chain.last() else {
                continue;
            };
            self.ensure_chain(chain);
            let key = Self::col_key(last);
            let idx = match bucket_index.get(&key) {
                Some(&i) => i,
                None => {
                    bucket_index.insert(key.clone(), buckets.len());
                    buckets.push((key, Vec::new()));
                    buckets.len() - 1
                }
            };
            buckets[idx].1.push(field.clone());
        }

        for (key, bucket) in buckets {
            let items = convert_fields_aggregate(&bucket);
            if items.is_empty() {
                continue;
            }
            let web_report = Report {
                report_id: rid,
                items,
            };
            if let Some(n) = self.nodes.get_mut(&key) {
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
