use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    pub name: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub tabs: Vec<TabDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabDocument {
    pub id: String,
    pub name: String,
    pub custom_name: Option<String>,
    pub icon: Option<String>,
    pub cwd: String,
    pub root: PaneTree,
    pub file: Option<TabFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabFile {
    pub path: String,
    pub language: String,
    pub markdown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PaneTree {
    Leaf {
        id: String,
        cwd: String,
        #[serde(default, rename = "sessionId")]
        session_id: Option<String>,
        #[serde(default)]
        agent: Option<PaneAgentSummary>,
        #[serde(default, rename = "runtimeStatus")]
        runtime_status: Option<String>,
        #[serde(default, rename = "runtimeTitle")]
        runtime_title: Option<String>,
    },
    Split {
        id: String,
        direction: SplitDirection,
        children: Vec<PaneTree>,
        sizes: Vec<f64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Row,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaneAgentSummary {
    pub kind: String,
    pub command: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", content = "data", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // keep TypeScript/Rust operation payloads structurally identical
pub enum WorkspaceOperation {
    RenameWorkspace {
        name: String,
    },
    SetWorkspaceIcon {
        icon: Option<String>,
    },
    AddTab {
        tab: TabDocument,
        index: Option<usize>,
    },
    RemoveTab {
        tab_id: String,
    },
    ReorderTab {
        tab_id: String,
        index: usize,
    },
    RenameTab {
        tab_id: String,
        name: String,
    },
    ClearTabCustomName {
        tab_id: String,
    },
    SetTabAutoName {
        tab_id: String,
        name: String,
    },
    SetTabIcon {
        tab_id: String,
        icon: Option<String>,
    },
    SplitPane {
        tab_id: String,
        target_pane_id: String,
        split_id: String,
        new_pane_id: String,
        direction: SplitDirection,
        cwd: String,
    },
    ClosePane {
        tab_id: String,
        pane_id: String,
    },
    SetSplitSizes {
        tab_id: String,
        split_id: String,
        sizes: Vec<f64>,
    },
    UpdatePaneCwd {
        tab_id: String,
        pane_id: String,
        cwd: String,
    },
    BindSession {
        pane_id: String,
        session_id: String,
    },
    SetPaneAgent {
        pane_id: String,
        agent: Option<PaneAgentSummary>,
    },
    SetPaneRuntimeStatus {
        pane_id: String,
        status: Option<String>,
    },
    SetPaneRuntimeTitle {
        pane_id: String,
        title: Option<String>,
    },
}

impl WorkspaceDocument {
    pub fn tab_id_for_pane(&self, pane_id: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|tab| tree_contains_pane(&tab.root, pane_id))
            .map(|tab| tab.id.clone())
    }

    pub fn pane_ids_for_tab(&self, tab_id: &str) -> Vec<String> {
        let mut ids = Vec::new();
        if let Some(tab) = self.tabs.iter().find(|tab| tab.id == tab_id) {
            collect_pane_ids(&tab.root, &mut ids);
        }
        ids
    }

    pub fn agent_for_pane(&self, pane_id: &str) -> Option<PaneAgentSummary> {
        self.tabs
            .iter()
            .find_map(|tab| agent_for_pane(&tab.root, pane_id))
    }

    pub fn cwd_for_pane(&self, pane_id: &str) -> Option<String> {
        self.tabs
            .iter()
            .find_map(|tab| cwd_for_pane(&tab.root, pane_id))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("workspace id is empty".into());
        }
        if self.name.trim().is_empty() {
            return Err("workspace name is empty".into());
        }
        let mut ids = HashSet::new();
        for tab in &self.tabs {
            if !ids.insert(tab.id.as_str()) {
                return Err(format!("duplicate id: {}", tab.id));
            }
            validate_tree(&tab.root, &mut ids)?;
        }
        Ok(())
    }

    pub fn apply(&mut self, operation: WorkspaceOperation) -> Result<(), String> {
        match operation {
            WorkspaceOperation::RenameWorkspace { name } => {
                if name.trim().is_empty() {
                    return Err("workspace name is empty".into());
                }
                self.name = name;
            }
            WorkspaceOperation::SetWorkspaceIcon { icon } => self.icon = non_empty(icon),
            WorkspaceOperation::AddTab { tab, index } => {
                if self.tabs.iter().any(|item| item.id == tab.id) {
                    return Err(format!("tab already exists: {}", tab.id));
                }
                let at = index.unwrap_or(self.tabs.len()).min(self.tabs.len());
                self.tabs.insert(at, tab);
            }
            WorkspaceOperation::RemoveTab { tab_id } => {
                let before = self.tabs.len();
                self.tabs.retain(|tab| tab.id != tab_id);
                if self.tabs.len() == before {
                    return Err(format!("tab not found: {tab_id}"));
                }
            }
            WorkspaceOperation::ReorderTab { tab_id, index } => {
                let from = self
                    .tabs
                    .iter()
                    .position(|tab| tab.id == tab_id)
                    .ok_or_else(|| format!("tab not found: {tab_id}"))?;
                let tab = self.tabs.remove(from);
                let at = index.min(self.tabs.len());
                self.tabs.insert(at, tab);
            }
            WorkspaceOperation::RenameTab { tab_id, name } => {
                let tab = find_tab_mut(self, &tab_id)?;
                tab.name = name.clone();
                tab.custom_name = Some(name);
            }
            WorkspaceOperation::ClearTabCustomName { tab_id } => {
                find_tab_mut(self, &tab_id)?.custom_name = None;
            }
            WorkspaceOperation::SetTabAutoName { tab_id, name } => {
                let tab = find_tab_mut(self, &tab_id)?;
                if tab.custom_name.is_none() {
                    tab.name = name;
                }
            }
            WorkspaceOperation::SetTabIcon { tab_id, icon } => {
                find_tab_mut(self, &tab_id)?.icon = non_empty(icon);
            }
            WorkspaceOperation::SplitPane {
                tab_id,
                target_pane_id,
                split_id,
                new_pane_id,
                direction,
                cwd,
            } => {
                let tab = find_tab_mut(self, &tab_id)?;
                let new_leaf = PaneTree::Leaf {
                    id: new_pane_id,
                    cwd,
                    session_id: None,
                    agent: None,
                    runtime_status: None,
                    runtime_title: None,
                };
                if !split_tree(
                    &mut tab.root,
                    &target_pane_id,
                    direction,
                    &split_id,
                    new_leaf,
                ) {
                    return Err(format!("pane not found: {target_pane_id}"));
                }
            }
            WorkspaceOperation::ClosePane { tab_id, pane_id } => {
                let tab_index = self
                    .tabs
                    .iter()
                    .position(|tab| tab.id == tab_id)
                    .ok_or_else(|| format!("tab not found: {tab_id}"))?;
                let root = remove_pane(self.tabs[tab_index].root.clone(), &pane_id);
                match root {
                    Some(root) => self.tabs[tab_index].root = root,
                    None => {
                        self.tabs.remove(tab_index);
                    }
                }
            }
            WorkspaceOperation::SetSplitSizes {
                tab_id,
                split_id,
                sizes,
            } => {
                let root = &mut find_tab_mut(self, &tab_id)?.root;
                if !set_split_sizes(root, &split_id, sizes) {
                    return Err(format!("split not found: {split_id}"));
                }
            }
            WorkspaceOperation::UpdatePaneCwd {
                tab_id,
                pane_id,
                cwd,
            } => {
                let tab = find_tab_mut(self, &tab_id)?;
                if !update_leaf(&mut tab.root, &pane_id, |leaf_cwd, _, _, _| {
                    *leaf_cwd = cwd.clone();
                }) {
                    return Err(format!("pane not found: {pane_id}"));
                }
            }
            WorkspaceOperation::BindSession {
                pane_id,
                session_id,
            } => {
                if !update_workspace_leaf(self, &pane_id, |_, current, _, _| {
                    *current = Some(session_id.clone());
                }) {
                    return Err(format!("pane not found: {pane_id}"));
                }
            }
            WorkspaceOperation::SetPaneAgent { pane_id, agent } => {
                if !update_workspace_leaf(self, &pane_id, |_, _, current, _| {
                    *current = agent.clone();
                }) {
                    return Err(format!("pane not found: {pane_id}"));
                }
            }
            WorkspaceOperation::SetPaneRuntimeStatus { pane_id, status } => {
                if !update_workspace_leaf(self, &pane_id, |_, _, _, current| {
                    *current = status.clone();
                }) {
                    return Err(format!("pane not found: {pane_id}"));
                }
            }
            WorkspaceOperation::SetPaneRuntimeTitle { pane_id, title } => {
                if !update_runtime_title(self, &pane_id, title.clone()) {
                    return Err(format!("pane not found: {pane_id}"));
                }
            }
        }
        self.validate()
    }
}

fn agent_for_pane(tree: &PaneTree, pane_id: &str) -> Option<PaneAgentSummary> {
    match tree {
        PaneTree::Leaf { id, agent, .. } if id == pane_id => agent.clone(),
        PaneTree::Leaf { .. } => None,
        PaneTree::Split { children, .. } => children
            .iter()
            .find_map(|child| agent_for_pane(child, pane_id)),
    }
}

fn cwd_for_pane(tree: &PaneTree, pane_id: &str) -> Option<String> {
    match tree {
        PaneTree::Leaf { id, cwd, .. } if id == pane_id => Some(cwd.clone()),
        PaneTree::Leaf { .. } => None,
        PaneTree::Split { children, .. } => children
            .iter()
            .find_map(|child| cwd_for_pane(child, pane_id)),
    }
}

fn find_tab_mut<'a>(
    workspace: &'a mut WorkspaceDocument,
    tab_id: &str,
) -> Result<&'a mut TabDocument, String> {
    workspace
        .tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| format!("tab not found: {tab_id}"))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn validate_tree<'a>(tree: &'a PaneTree, ids: &mut HashSet<&'a str>) -> Result<(), String> {
    match tree {
        PaneTree::Leaf {
            id,
            cwd,
            agent,
            runtime_status,
            ..
        } => {
            if id.is_empty() || !ids.insert(id) {
                return Err(format!("duplicate/empty pane id: {id}"));
            }
            if cwd.trim().is_empty() {
                return Err(format!("empty pane cwd: {id}"));
            }
            if let Some(status) = runtime_status {
                if !matches!(status.as_str(), "working" | "idle" | "permission") {
                    return Err(format!("invalid pane runtime status: {status}"));
                }
            }
            if let Some(agent) = agent {
                if !matches!(agent.kind.as_str(), "claude" | "codex" | "opencode") {
                    return Err(format!("invalid pane agent kind: {}", agent.kind));
                }
                if agent.command.trim().is_empty() || agent.session_id.trim().is_empty() {
                    return Err(format!("incomplete pane agent metadata: {id}"));
                }
            }
        }
        PaneTree::Split {
            id,
            children,
            sizes,
            ..
        } => {
            if id.is_empty() || !ids.insert(id) {
                return Err(format!("duplicate/empty split id: {id}"));
            }
            if children.len() < 2 || children.len() != sizes.len() {
                return Err(format!("invalid split shape: {id}"));
            }
            if sizes.iter().any(|size| !size.is_finite() || *size <= 0.0) {
                return Err(format!("invalid split sizes: {id}"));
            }
            for child in children {
                validate_tree(child, ids)?;
            }
        }
    }
    Ok(())
}

fn tree_contains_pane(tree: &PaneTree, pane_id: &str) -> bool {
    match tree {
        PaneTree::Leaf { id, .. } => id == pane_id,
        PaneTree::Split { children, .. } => children
            .iter()
            .any(|child| tree_contains_pane(child, pane_id)),
    }
}

fn collect_pane_ids(tree: &PaneTree, ids: &mut Vec<String>) {
    match tree {
        PaneTree::Leaf { id, .. } => ids.push(id.clone()),
        PaneTree::Split { children, .. } => {
            for child in children {
                collect_pane_ids(child, ids);
            }
        }
    }
}

fn split_tree(
    tree: &mut PaneTree,
    target: &str,
    direction: SplitDirection,
    split_id: &str,
    new_leaf: PaneTree,
) -> bool {
    if let PaneTree::Split {
        direction: existing_direction,
        children,
        sizes,
        ..
    } = tree
    {
        if *existing_direction == direction {
            if let Some(index) = children
                .iter()
                .position(|child| matches!(child, PaneTree::Leaf { id, .. } if id == target))
            {
                children.insert(index + 1, new_leaf);
                let size = 100.0 / children.len() as f64;
                *sizes = vec![size; children.len()];
                return true;
            }
        }
        for child in children.iter_mut() {
            if split_tree(child, target, direction, split_id, new_leaf.clone()) {
                return true;
            }
        }
        return false;
    }
    if matches!(tree, PaneTree::Leaf { id, .. } if id == target) {
        let old = tree.clone();
        *tree = PaneTree::Split {
            id: split_id.to_string(),
            direction,
            children: vec![old, new_leaf],
            sizes: vec![50.0, 50.0],
        };
        true
    } else {
        false
    }
}

fn remove_pane(tree: PaneTree, target: &str) -> Option<PaneTree> {
    match tree {
        PaneTree::Leaf { ref id, .. } if id == target => None,
        PaneTree::Leaf { .. } => Some(tree),
        PaneTree::Split {
            id,
            direction,
            children,
            ..
        } => {
            let children = children
                .into_iter()
                .filter_map(|child| remove_pane(child, target))
                .collect::<Vec<_>>();
            match children.len() {
                0 => None,
                1 => children.into_iter().next(),
                count => Some(PaneTree::Split {
                    id,
                    direction,
                    children,
                    sizes: vec![100.0 / count as f64; count],
                }),
            }
        }
    }
}

fn set_split_sizes(tree: &mut PaneTree, target: &str, sizes: Vec<f64>) -> bool {
    match tree {
        PaneTree::Leaf { .. } => false,
        PaneTree::Split {
            id,
            children,
            sizes: current,
            ..
        } => {
            if id == target {
                if sizes.len() != children.len() {
                    return false;
                }
                *current = sizes;
                return true;
            }
            children
                .iter_mut()
                .any(|child| set_split_sizes(child, target, sizes.clone()))
        }
    }
}

fn update_workspace_leaf<F>(workspace: &mut WorkspaceDocument, pane_id: &str, update: F) -> bool
where
    F: Fn(&mut String, &mut Option<String>, &mut Option<PaneAgentSummary>, &mut Option<String>)
        + Copy,
{
    workspace
        .tabs
        .iter_mut()
        .any(|tab| update_leaf(&mut tab.root, pane_id, update))
}

fn update_leaf<F>(tree: &mut PaneTree, pane_id: &str, update: F) -> bool
where
    F: Fn(&mut String, &mut Option<String>, &mut Option<PaneAgentSummary>, &mut Option<String>)
        + Copy,
{
    match tree {
        PaneTree::Leaf {
            id,
            cwd,
            session_id,
            agent,
            runtime_status,
            ..
        } => {
            if id != pane_id {
                return false;
            }
            update(cwd, session_id, agent, runtime_status);
            true
        }
        PaneTree::Split { children, .. } => children
            .iter_mut()
            .any(|child| update_leaf(child, pane_id, update)),
    }
}

fn update_runtime_title(
    workspace: &mut WorkspaceDocument,
    pane_id: &str,
    title: Option<String>,
) -> bool {
    fn update(tree: &mut PaneTree, pane_id: &str, title: &Option<String>) -> bool {
        match tree {
            PaneTree::Leaf {
                id, runtime_title, ..
            } if id == pane_id => {
                *runtime_title = title.clone();
                true
            }
            PaneTree::Leaf { .. } => false,
            PaneTree::Split { children, .. } => children
                .iter_mut()
                .any(|child| update(child, pane_id, title)),
        }
    }
    workspace
        .tabs
        .iter_mut()
        .any(|tab| update(&mut tab.root, pane_id, &title))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> WorkspaceDocument {
        WorkspaceDocument {
            id: "w".into(),
            revision: 1,
            name: "Work".into(),
            icon: None,
            tabs: vec![TabDocument {
                id: "t".into(),
                name: "shell".into(),
                custom_name: None,
                icon: None,
                cwd: "/tmp".into(),
                root: PaneTree::Leaf {
                    id: "p1".into(),
                    cwd: "/tmp".into(),
                    session_id: None,
                    agent: None,
                    runtime_status: None,
                    runtime_title: None,
                },
                file: None,
            }],
        }
    }

    #[test]
    fn applies_split_close_and_bind_session() {
        let mut workspace = workspace();
        workspace
            .apply(WorkspaceOperation::SplitPane {
                tab_id: "t".into(),
                target_pane_id: "p1".into(),
                split_id: "s".into(),
                new_pane_id: "p2".into(),
                direction: SplitDirection::Row,
                cwd: "/tmp".into(),
            })
            .unwrap();
        workspace
            .apply(WorkspaceOperation::BindSession {
                pane_id: "p2".into(),
                session_id: "session".into(),
            })
            .unwrap();
        workspace
            .apply(WorkspaceOperation::ClosePane {
                tab_id: "t".into(),
                pane_id: "p1".into(),
            })
            .unwrap();
        assert!(matches!(
            workspace.tabs[0].root,
            PaneTree::Leaf {
                ref id,
                session_id: Some(ref session),
                ..
            } if id == "p2" && session == "session"
        ));
    }

    #[test]
    fn rejects_duplicate_ids() {
        let mut workspace = workspace();
        workspace.tabs.push(workspace.tabs[0].clone());
        assert!(workspace.validate().is_err());
    }

    #[test]
    fn rejects_non_finite_split_sizes() {
        let mut workspace = workspace();
        workspace
            .apply(WorkspaceOperation::SplitPane {
                tab_id: "t".into(),
                target_pane_id: "p1".into(),
                split_id: "s".into(),
                new_pane_id: "p2".into(),
                direction: SplitDirection::Row,
                cwd: "/tmp".into(),
            })
            .unwrap();
        assert!(workspace
            .apply(WorkspaceOperation::SetSplitSizes {
                tab_id: "t".into(),
                split_id: "s".into(),
                sizes: vec![f64::NAN, 50.0],
            })
            .is_err());
    }

    #[test]
    fn rejects_unknown_runtime_and_agent_enums() {
        let mut invalid_status = workspace();
        assert!(invalid_status
            .apply(WorkspaceOperation::SetPaneRuntimeStatus {
                pane_id: "p1".into(),
                status: Some("future".into()),
            })
            .is_err());
        let mut invalid_agent = workspace();
        assert!(invalid_agent
            .apply(WorkspaceOperation::SetPaneAgent {
                pane_id: "p1".into(),
                agent: Some(PaneAgentSummary {
                    kind: "unknown".into(),
                    command: "unknown".into(),
                    session_id: "s".into(),
                }),
            })
            .is_err());
    }
}
