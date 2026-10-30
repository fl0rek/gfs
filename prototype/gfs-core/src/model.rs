//! PROTOTYPE. Object model of a comb: blobs, trees and history entries.
//!
//! Everything is content-addressed with BLAKE3 under a domain prefix, so a
//! blob, a tree and an entry with identical bytes never collide.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Hash = String; // lowercase hex, 64 chars

pub fn hash_bytes(domain: &str, bytes: &[u8]) -> Hash {
    let mut h = blake3::Hasher::new();
    h.update(domain.as_bytes());
    h.update(b"\0");
    h.update(bytes);
    hex::encode(h.finalize().as_bytes())
}

pub fn blob_hash(bytes: &[u8]) -> Hash {
    hash_bytes("blob", bytes)
}

/// A directory listing. Name → (kind, hash). Kind is "f" or "d".
/// Serialized canonically as sorted `kind name hash\n` lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tree {
    pub entries: BTreeMap<String, TreeEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub kind: Kind,
    pub hash: Hash,
    /// Size in bytes for files, entry count for dirs. Informational only; not part of the hash.
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
}

impl Kind {
    fn tag(self) -> &'static str {
        match self {
            Kind::File => "f",
            Kind::Dir => "d",
        }
    }
}

impl Tree {
    pub fn canonical(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, e) in &self.entries {
            out.extend_from_slice(e.kind.tag().as_bytes());
            out.push(b' ');
            out.extend_from_slice(e.hash.as_bytes());
            out.push(b' ');
            out.extend_from_slice(e.size.to_string().as_bytes());
            out.push(b' ');
            out.extend_from_slice(name.as_bytes());
            out.push(b'\n');
        }
        out
    }

    pub fn hash(&self) -> Hash {
        hash_bytes("tree", &self.canonical())
    }

    pub fn parse(bytes: &[u8]) -> Option<Tree> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut t = Tree::default();
        for line in text.lines() {
            let mut it = line.splitn(4, ' ');
            let kind = match it.next()? {
                "f" => Kind::File,
                "d" => Kind::Dir,
                _ => return None,
            };
            let hash = it.next()?.to_string();
            let size = it.next()?.parse().ok()?;
            let name = it.next()?.to_string();
            t.entries.insert(name, TreeEntry { kind, hash, size });
        }
        Some(t)
    }
}

/// Who made a change. The author is the session acting for a principal;
/// the committer is the node (see "What one entry in a comb's history is").
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Author {
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub principal: String,
}

/// What kind of change an entry records.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntryKind {
    /// The first entry of a comb: an empty tree.
    Genesis,
    /// One tool call that changed this comb.
    ToolCall {
        tool_call_id: String,
        turn_id: String,
        tool_name: String,
        /// Hash of a blob holding the tool's arguments as JSON (stored by hash, prunable).
        args_hash: Option<Hash>,
    },
    /// Writes outside any tool call, coalesced per turn.
    Turn { turn_id: String },
    /// An edit that arrived from outside the harness.
    External,
    /// A rollback: the tree is a copy of an earlier entry's tree.
    Rollback { to_entry: Hash },
    /// The comb took a git remote's tree (connecting to it, or a commit pushed there by someone else).
    Pull { remote: String, commit: String },
    /// The node switched the running system to this comb's state at `at_entry`
    /// (the tree is unchanged; this records the event itself).
    Switch { at_entry: Hash, previous: Option<Hash>, system: String },
}

/// One link in a comb's history chain. Its id is the hash of its canonical JSON.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub comb: String,
    pub parent: Option<Hash>,
    pub tree: Hash,
    #[serde(flatten)]
    pub kind: EntryKind,
    pub author: Author,
    pub committer: String,
    /// Unix milliseconds.
    pub time: u64,
    /// Generated, never waiting on a model.
    pub message: String,
    /// Files changed relative to the parent, for display. Not needed for verification.
    pub summary: ChangeSummary,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeSummary {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

impl Entry {
    pub fn canonical(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("entry serializes")
    }
    pub fn id(&self) -> Hash {
        hash_bytes("entry", &self.canonical())
    }
}
