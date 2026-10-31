//! PROTOTYPE. Git interop: a comb mirrored to a git remote.
//!
//! gfs stays the local truth (BLAKE3 objects, its own chain). A comb connected to a
//! git remote gets one git commit per history entry: the entry's tree in git's
//! encoding, its provenance in trailers. Git ids (SHA-1) are derived here from gfs
//! objects on demand; blobs are never stored twice (a git blob points at the gfs blob).
//!
//! What gfs cannot hold (the exec bit, symlinks, submodules) travels in a *mode
//! overlay*: `path → "100755" | "120000" | "160000 <oid>"`, kept by the sync state,
//! so a tree imported from git encodes back to the same git tree id.

use crate::combs::{Datacombs, Flat, GfsError, Result};
use crate::model::{Entry, EntryKind, Hash, Kind};
use crate::store::Store;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap, HashSet};

pub type Oid = [u8; 20];

pub fn hex_oid(o: &Oid) -> String {
    hex::encode(o)
}

pub fn parse_oid(s: &str) -> Result<Oid> {
    let v = hex::decode(s.trim()).map_err(|_| GfsError::Other(format!("bad git id: {s}")))?;
    v.try_into().map_err(|_| GfsError::Other(format!("bad git id: {s}")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ObjType {
    Commit = 1,
    Tree = 2,
    Blob = 3,
    Tag = 4,
}

impl ObjType {
    pub fn name(self) -> &'static str {
        match self {
            ObjType::Commit => "commit",
            ObjType::Tree => "tree",
            ObjType::Blob => "blob",
            ObjType::Tag => "tag",
        }
    }
    fn from_code(c: u8) -> Option<ObjType> {
        Some(match c {
            1 => ObjType::Commit,
            2 => ObjType::Tree,
            3 => ObjType::Blob,
            4 => ObjType::Tag,
            _ => return None,
        })
    }
}

pub fn object_id(t: ObjType, body: &[u8]) -> Oid {
    let mut h = Sha1::new();
    h.update(t.name().as_bytes());
    h.update(b" ");
    h.update(body.len().to_string().as_bytes());
    h.update([0u8]);
    h.update(body);
    let mut o = [0u8; 20];
    o.copy_from_slice(&h.finalize());
    o
}

/// A git object we can produce: either raw bytes, or a blob that lives in the gfs store.
enum GitObj {
    Blob(Hash),
    Raw(ObjType, Vec<u8>),
}

/// One entry of a mode overlay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Special {
    Mode(String),
    Gitlink(Oid),
}

pub type Overlay = BTreeMap<String, Special>;

pub fn parse_overlay(m: &BTreeMap<String, String>) -> Result<Overlay> {
    let mut out = Overlay::new();
    for (p, v) in m {
        let s = match v.split_once(' ') {
            Some(("160000", oid)) => Special::Gitlink(parse_oid(oid)?),
            _ => Special::Mode(v.clone()),
        };
        out.insert(p.clone(), s);
    }
    Ok(out)
}

pub fn overlay_to_strings(o: &Overlay) -> BTreeMap<String, String> {
    o.iter()
        .map(|(p, s)| {
            let v = match s {
                Special::Mode(m) => m.clone(),
                Special::Gitlink(oid) => format!("160000 {}", hex_oid(oid)),
            };
            (p.clone(), v)
        })
        .collect()
}

/// A git identity line's parts.
#[derive(Clone, Debug)]
pub struct Ident {
    pub name: String,
    pub email: String,
    /// Unix seconds.
    pub time: u64,
}

impl Ident {
    fn line(&self) -> String {
        let clean = |s: &str| s.chars().filter(|c| !matches!(c, '<' | '>' | '\n' | '\0')).collect::<String>().trim().to_string();
        format!("{} <{}> {} +0000", clean(&self.name), clean(&self.email), self.time)
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct CommitInfo {
    pub tree: String,
    pub parents: Vec<String>,
    pub author: String,
    pub committer: String,
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct EncodedEntry {
    pub commit: String,
    pub tree: String,
}

#[derive(Default)]
pub struct GitCache {
    objects: HashMap<Oid, GitObj>,
    /// gfs blob hash → git blob id
    blob_oids: HashMap<Hash, Oid>,
    /// (gfs tree hash, overlay key) → git tree id
    tree_oids: HashMap<(Hash, String), Oid>,
}

impl GitCache {
    pub fn has(&self, oid: &Oid) -> bool {
        self.objects.contains_key(oid)
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    fn put_raw(&mut self, t: ObjType, body: Vec<u8>) -> Oid {
        let oid = object_id(t, &body);
        self.objects.entry(oid).or_insert(GitObj::Raw(t, body));
        oid
    }

    /// Type and body of an object we hold.
    pub fn read(&self, store: &Store, oid: &Oid) -> Result<(ObjType, Vec<u8>)> {
        match self.objects.get(oid) {
            Some(GitObj::Raw(t, b)) => Ok((*t, b.clone())),
            Some(GitObj::Blob(h)) => {
                let b = store.get(h).ok_or_else(|| GfsError::NotFound(h.clone()))?;
                Ok((ObjType::Blob, b.to_vec()))
            }
            None => Err(GfsError::NotFound(format!("git object {}", hex_oid(oid)))),
        }
    }

    fn encode_blob(&mut self, store: &Store, gfs_hash: &str) -> Result<Oid> {
        if let Some(o) = self.blob_oids.get(gfs_hash) {
            return Ok(*o);
        }
        let bytes = store.get(gfs_hash).ok_or_else(|| GfsError::NotFound(gfs_hash.to_string()))?;
        let oid = object_id(ObjType::Blob, bytes);
        self.objects.entry(oid).or_insert(GitObj::Blob(gfs_hash.to_string()));
        self.blob_oids.insert(gfs_hash.to_string(), oid);
        Ok(oid)
    }

    /// Encode a gfs tree (None = a directory that exists only in the overlay) as a git tree.
    pub fn encode_tree(&mut self, store: &Store, gfs_tree: Option<&str>, prefix: &str, overlay: &Overlay) -> Result<Oid> {
        let dir_prefix = if prefix.is_empty() { String::new() } else { format!("{prefix}/") };
        let touches_overlay = overlay.range(dir_prefix.clone()..).next().map(|(k, _)| k.starts_with(&dir_prefix)).unwrap_or(false);
        let memo_key = gfs_tree.map(|h| (h.to_string(), if touches_overlay { prefix.to_string() } else { String::new() }));
        if let Some(k) = &memo_key {
            if let Some(o) = self.tree_oids.get(k) {
                return Ok(*o);
            }
        }
        // name → (mode, oid, is_dir)
        let mut entries: BTreeMap<String, (String, Oid, bool)> = BTreeMap::new();
        if let Some(h) = gfs_tree {
            let bytes = store.get(h).ok_or_else(|| GfsError::NotFound(h.to_string()))?;
            let tree = crate::model::Tree::parse(bytes).ok_or_else(|| GfsError::Corrupt(h.to_string(), "unparsable tree".into()))?;
            for (name, e) in &tree.entries {
                let path = format!("{dir_prefix}{name}");
                match e.kind {
                    Kind::File => {
                        let oid = self.encode_blob(store, &e.hash)?;
                        let mode = match overlay.get(&path) {
                            Some(Special::Mode(m)) if m == "100755" || m == "120000" => m.clone(),
                            _ => "100644".to_string(),
                        };
                        entries.insert(name.clone(), (mode, oid, false));
                    }
                    Kind::Dir => {
                        let oid = self.encode_tree(store, Some(&e.hash), &path, overlay)?;
                        entries.insert(name.clone(), ("40000".into(), oid, true));
                    }
                }
            }
        }
        // Submodules: gfs can't hold them, the overlay carries them (including directories made only of them).
        let mut overlay_dirs: HashSet<String> = HashSet::new();
        for (path, s) in overlay.range(dir_prefix.clone()..) {
            if !path.starts_with(&dir_prefix) {
                break;
            }
            let Special::Gitlink(oid) = s else { continue };
            let rest = &path[dir_prefix.len()..];
            match rest.split_once('/') {
                None => {
                    entries.entry(rest.to_string()).or_insert(("160000".into(), *oid, false));
                }
                Some((d, _)) => {
                    if !entries.contains_key(d) {
                        overlay_dirs.insert(d.to_string());
                    }
                }
            }
        }
        for d in overlay_dirs {
            let oid = self.encode_tree(store, None, &format!("{dir_prefix}{d}"), overlay)?;
            entries.insert(d, ("40000".into(), oid, true));
        }
        let body = tree_body(&entries);
        let oid = self.put_raw(ObjType::Tree, body);
        if let Some(k) = memo_key {
            self.tree_oids.insert(k, oid);
        }
        Ok(oid)
    }

    /// Every tree and blob reachable from a tree (gitlinks excluded: they point outside the repo).
    pub fn reachable_from_tree(&self, store: &Store, tree: &Oid, out: &mut HashSet<Oid>) -> Result<()> {
        if !out.insert(*tree) {
            return Ok(());
        }
        let (_, body) = self.read(store, tree)?;
        for (mode, _, oid) in parse_tree_body(&body)? {
            if mode == "40000" || mode == "040000" {
                self.reachable_from_tree(store, &oid, out)?;
            } else if mode != "160000" {
                out.insert(oid);
            }
        }
        Ok(())
    }

    pub fn commit_info(&self, store: &Store, oid: &Oid) -> Result<CommitInfo> {
        let (t, body) = self.read(store, oid)?;
        if t != ObjType::Commit {
            return Err(GfsError::Other(format!("{} is a {}, not a commit", hex_oid(oid), t.name())));
        }
        parse_commit(&body)
    }

    /// A packfile holding `commits`, their trees, and every tree/blob not reachable from `have_trees`.
    pub fn build_pack(&self, store: &Store, commits: &[Oid], have_trees: &[Oid]) -> Result<Vec<u8>> {
        let mut have = HashSet::new();
        for t in have_trees {
            // A tree we can't encode (not in the cache) just isn't excluded.
            if self.objects.contains_key(t) {
                self.reachable_from_tree(store, t, &mut have)?;
            }
        }
        let mut order: Vec<Oid> = Vec::new();
        let mut seen: HashSet<Oid> = HashSet::new();
        for c in commits {
            if seen.insert(*c) {
                order.push(*c);
            }
            let info = self.commit_info(store, c)?;
            let tree = parse_oid(&info.tree)?;
            let mut reach = HashSet::new();
            self.reachable_from_tree(store, &tree, &mut reach)?;
            // Deterministic order: trees and blobs sorted by id.
            let mut v: Vec<Oid> = reach.into_iter().filter(|o| !have.contains(o)).collect();
            v.sort();
            for o in v {
                if seen.insert(o) {
                    order.push(o);
                }
            }
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"PACK");
        out.extend_from_slice(&2u32.to_be_bytes());
        out.extend_from_slice(&(order.len() as u32).to_be_bytes());
        for oid in &order {
            let (t, body) = self.read(store, oid)?;
            write_obj_header(&mut out, t as u8, body.len());
            out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(&body, 6));
        }
        let mut h = Sha1::new();
        h.update(&out);
        out.extend_from_slice(&h.finalize());
        Ok(out)
    }

    /// Read a packfile into the cache: blobs go into the gfs store, the rest stays here.
    /// Returns every object id it held.
    pub fn index_pack(&mut self, store: &mut Store, pack: &[u8]) -> Result<Vec<(ObjType, Oid)>> {
        let objs = parse_pack(pack)?;
        let mut out = Vec::with_capacity(objs.len());
        for (t, body) in objs {
            let oid = object_id(t, &body);
            if t == ObjType::Blob {
                let h = store.put("blob", body);
                self.objects.entry(oid).or_insert(GitObj::Blob(h.clone()));
                self.blob_oids.insert(h, oid);
            } else {
                self.objects.entry(oid).or_insert(GitObj::Raw(t, body));
            }
            out.push((t, oid));
        }
        Ok(out)
    }

    /// Add one object given its type and body (e.g. fetched through a forge's REST API).
    pub fn put_object(&mut self, store: &mut Store, t: ObjType, body: Vec<u8>) -> Oid {
        let oid = object_id(t, &body);
        if t == ObjType::Blob {
            let h = store.put("blob", body);
            self.objects.entry(oid).or_insert(GitObj::Blob(h.clone()));
            self.blob_oids.insert(h, oid);
        } else {
            self.objects.entry(oid).or_insert(GitObj::Raw(t, body));
        }
        oid
    }

    /// Build git trees from a flat listing `(path, mode, oid)` of blobs and gitlinks
    /// (what a forge's REST API returns). Returns the root tree id.
    pub fn put_listing(&mut self, listing: &[(String, String, Oid)]) -> Oid {
        #[derive(Default)]
        struct Dir {
            entries: BTreeMap<String, (String, Oid, bool)>,
            dirs: BTreeMap<String, Dir>,
        }
        let mut root = Dir::default();
        for (path, mode, oid) in listing {
            let parts: Vec<&str> = path.split('/').collect();
            let mut d = &mut root;
            for p in &parts[..parts.len() - 1] {
                d = d.dirs.entry(p.to_string()).or_default();
            }
            d.entries.insert(parts[parts.len() - 1].to_string(), (mode.clone(), *oid, false));
        }
        fn write(g: &mut GitCache, d: &Dir) -> Oid {
            let mut entries = d.entries.clone();
            for (name, child) in &d.dirs {
                entries.insert(name.clone(), ("40000".into(), write(g, child), true));
            }
            g.put_raw(ObjType::Tree, tree_body(&entries))
        }
        write(self, &root)
    }

    /// Flatten a git tree into files (gfs blob hashes) plus the overlay gfs can't hold.
    pub fn flatten(&self, store: &Store, tree: &Oid, prefix: &str, files: &mut BTreeMap<String, Hash>, overlay: &mut Overlay) -> Result<()> {
        let (_, body) = self.read(store, tree)?;
        for (mode, name, oid) in parse_tree_body(&body)? {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            match mode.as_str() {
                "40000" | "040000" => self.flatten(store, &oid, &path, files, overlay)?,
                "160000" => {
                    overlay.insert(path, Special::Gitlink(oid));
                }
                m => {
                    let h = match self.objects.get(&oid) {
                        Some(GitObj::Blob(h)) => h.clone(),
                        _ => return Err(GfsError::NotFound(format!("git blob {} ({path})", hex_oid(&oid)))),
                    };
                    if m == "100755" || m == "120000" {
                        overlay.insert(path.clone(), Special::Mode(m.to_string()));
                    }
                    files.insert(path, h);
                }
            }
        }
        Ok(())
    }
}

fn tree_body(entries: &BTreeMap<String, (String, Oid, bool)>) -> Vec<u8> {
    // Git sorts by name bytes, with a directory compared as if its name ended in '/'.
    let mut v: Vec<(&String, &(String, Oid, bool))> = entries.iter().collect();
    v.sort_by(|a, b| {
        let ka = if a.1 .2 { format!("{}/", a.0) } else { a.0.clone() };
        let kb = if b.1 .2 { format!("{}/", b.0) } else { b.0.clone() };
        ka.as_bytes().cmp(kb.as_bytes())
    });
    let mut out = Vec::new();
    for (name, (mode, oid, _)) in v {
        out.extend_from_slice(mode.as_bytes());
        out.push(b' ');
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        out.extend_from_slice(oid);
    }
    out
}

pub fn parse_tree_body(body: &[u8]) -> Result<Vec<(String, String, Oid)>> {
    let bad = || GfsError::Other("unparsable git tree".into());
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        let sp = body[i..].iter().position(|&b| b == b' ').ok_or_else(bad)? + i;
        let nul = body[sp..].iter().position(|&b| b == 0).ok_or_else(bad)? + sp;
        if nul + 21 > body.len() {
            return Err(bad());
        }
        let mode = String::from_utf8_lossy(&body[i..sp]).into_owned();
        let name = String::from_utf8_lossy(&body[sp + 1..nul]).into_owned();
        let oid: Oid = body[nul + 1..nul + 21].try_into().unwrap();
        out.push((mode, name, oid));
        i = nul + 21;
    }
    Ok(out)
}

pub fn parse_commit(body: &[u8]) -> Result<CommitInfo> {
    let text = String::from_utf8_lossy(body);
    let (head, message) = text.split_once("\n\n").unwrap_or((&text, ""));
    let mut info = CommitInfo { tree: String::new(), parents: vec![], author: String::new(), committer: String::new(), message: message.to_string() };
    for line in head.lines() {
        if let Some(v) = line.strip_prefix("tree ") {
            info.tree = v.to_string();
        } else if let Some(v) = line.strip_prefix("parent ") {
            info.parents.push(v.to_string());
        } else if let Some(v) = line.strip_prefix("author ") {
            info.author = v.to_string();
        } else if let Some(v) = line.strip_prefix("committer ") {
            info.committer = v.to_string();
        }
    }
    if info.tree.is_empty() {
        return Err(GfsError::Other("commit without a tree".into()));
    }
    Ok(info)
}

/// The commit message for an entry: its generated message, then its provenance as trailers.
pub fn entry_message(id: &str, e: &Entry, node: &str) -> String {
    let mut t: Vec<(&str, String)> = vec![("Gfs-Comb", e.comb.clone()), ("Gfs-Entry", id.to_string())];
    match &e.kind {
        EntryKind::Genesis => t.push(("Gfs-Kind", "genesis".into())),
        EntryKind::ToolCall { tool_call_id, turn_id, tool_name, args_hash } => {
            t.push(("Gfs-Kind", "tool_call".into()));
            t.push(("Gfs-Tool", tool_name.clone()));
            t.push(("Gfs-Tool-Call", tool_call_id.clone()));
            t.push(("Gfs-Turn", turn_id.clone()));
            if let Some(a) = args_hash {
                t.push(("Gfs-Args", a.clone()));
            }
        }
        EntryKind::Turn { turn_id } => {
            t.push(("Gfs-Kind", "turn".into()));
            t.push(("Gfs-Turn", turn_id.clone()));
        }
        EntryKind::External => t.push(("Gfs-Kind", "external".into())),
        EntryKind::Pull { remote, commit } => {
            t.push(("Gfs-Kind", "pull".into()));
            t.push(("Gfs-Pull-Remote", remote.clone()));
            t.push(("Gfs-Pull-Commit", commit.clone()));
        }
        EntryKind::Rollback { to_entry } => {
            t.push(("Gfs-Kind", "rollback".into()));
            t.push(("Gfs-Rollback-To", to_entry.clone()));
        }
        EntryKind::Switch { at_entry, previous, system } => {
            t.push(("Gfs-Kind", "switch".into()));
            t.push(("Gfs-Switch-At", at_entry.clone()));
            if let Some(p) = previous {
                t.push(("Gfs-Switch-Previous", p.clone()));
            }
            if !system.is_empty() {
                t.push(("Gfs-System", system.clone()));
            }
        }
    }
    let a = &e.author;
    for (k, v) in [("Gfs-Session", &a.session), ("Gfs-Harness", &a.harness), ("Gfs-Model", &a.model), ("Gfs-Principal", &a.principal)] {
        if !v.is_empty() {
            t.push((k, v.clone()));
        }
    }
    t.push(("Gfs-Node", node.to_string()));
    if let Some(p) = &e.parent {
        t.push(("Gfs-Parent-Entry", p.clone()));
    }
    let mut msg = e.message.trim().to_string();
    msg.push_str("\n\n");
    for (k, v) in t {
        msg.push_str(&format!("{k}: {}\n", v.replace('\n', " ")));
    }
    msg
}

/// The git author of an entry: the session acting for you (see "What one entry in a comb's history is").
pub fn entry_author(e: &Entry, node: &str) -> Ident {
    let a = &e.author;
    let who = if a.harness.is_empty() { "gfs".to_string() } else { a.harness.clone() };
    let name = if a.model.is_empty() { who } else { format!("{who} ({})", a.model) };
    let session = if a.session.is_empty() { "unknown" } else { &a.session };
    Ident { name, email: format!("{session}@{node}"), time: e.time / 1000 }
}

impl Datacombs {
    /// Encode a history entry as a git commit with the given parents; the committer is the node.
    pub fn git_encode_entry(
        &self,
        git: &mut GitCache,
        entry_id: &str,
        parents: &[Oid],
        committer: (&str, &str),
        overlay: &Overlay,
    ) -> Result<EncodedEntry> {
        let e = self.entry(entry_id)?;
        let tree = git.encode_tree(&self.store, Some(&e.tree), "", overlay)?;
        let author = entry_author(&e, &self.node);
        let committer = Ident { name: committer.0.to_string(), email: committer.1.to_string(), time: e.time / 1000 };
        let mut body = format!("tree {}\n", hex_oid(&tree));
        for p in parents {
            body.push_str(&format!("parent {}\n", hex_oid(p)));
        }
        body.push_str(&format!("author {}\ncommitter {}\n\n", author.line(), committer.line()));
        body.push_str(&entry_message(entry_id, &e, &self.node));
        let commit = git.put_raw(ObjType::Commit, body.into_bytes());
        Ok(EncodedEntry { commit: hex_oid(&commit), tree: hex_oid(&tree) })
    }

    /// The git tree of an entry (for the "remote already has these" set).
    pub fn git_encode_entry_tree(&self, git: &mut GitCache, entry_id: &str, overlay: &Overlay) -> Result<String> {
        let e = self.entry(entry_id)?;
        Ok(hex_oid(&git.encode_tree(&self.store, Some(&e.tree), "", overlay)?))
    }

    /// Replace a comb's working tree with a git commit's tree. Returns the overlay of what gfs can't hold.
    pub fn git_checkout(&mut self, git: &GitCache, comb: &str, commit: &Oid) -> Result<Overlay> {
        let info = git.commit_info(&self.store, commit)?;
        self.git_checkout_tree(git, comb, &parse_oid(&info.tree)?)
    }

    /// Replace a comb's working tree with a git tree.
    pub fn git_checkout_tree(&mut self, git: &GitCache, comb: &str, tree: &Oid) -> Result<Overlay> {
        let tree = *tree;
        let mut files = BTreeMap::new();
        let mut overlay = Overlay::new();
        git.flatten(&self.store, &tree, "", &mut files, &mut overlay)?;
        let mut flat = Flat::new();
        for (p, h) in files {
            let b = self.store.get(&h).ok_or_else(|| GfsError::NotFound(h.clone()))?;
            flat.insert(p, b.to_vec());
        }
        self.set_working(comb, flat)?;
        Ok(overlay)
    }
}

// ---------- packfiles ----------

fn write_obj_header(out: &mut Vec<u8>, t: u8, size: usize) {
    let mut s = size;
    let mut b = (t << 4) | (s & 0x0f) as u8;
    s >>= 4;
    while s != 0 {
        out.push(b | 0x80);
        b = (s & 0x7f) as u8;
        s >>= 7;
    }
    out.push(b);
}

fn inflate_at(data: &[u8], size: usize) -> Result<(Vec<u8>, usize)> {
    use miniz_oxide::inflate::stream::{inflate, InflateState};
    use miniz_oxide::{DataFormat, MZFlush, MZStatus};
    let mut state = InflateState::new_boxed(DataFormat::Zlib);
    let mut out = vec![0u8; size + 1];
    let (mut ip, mut op) = (0usize, 0usize);
    loop {
        let r = inflate(&mut state, &data[ip..], &mut out[op..], MZFlush::Finish);
        ip += r.bytes_consumed;
        op += r.bytes_written;
        match r.status {
            Ok(MZStatus::StreamEnd) => break,
            Ok(_) if r.bytes_consumed > 0 || r.bytes_written > 0 => continue,
            other => return Err(GfsError::Other(format!("pack: inflate failed ({other:?}) at {ip}"))),
        }
    }
    if op != size {
        return Err(GfsError::Other(format!("pack: object inflated to {op} bytes, header said {size}")));
    }
    out.truncate(size);
    Ok((out, ip))
}

enum Raw {
    Full(ObjType, Vec<u8>),
    OfsDelta(usize, Vec<u8>),
    RefDelta(Oid, Vec<u8>),
}

/// Parse a v2/v3 packfile, resolving OFS_DELTA and REF_DELTA. Returns (type, body) per object.
pub fn parse_pack(pack: &[u8]) -> Result<Vec<(ObjType, Vec<u8>)>> {
    let bad = |m: &str| GfsError::Other(format!("pack: {m}"));
    if pack.len() < 32 || &pack[0..4] != b"PACK" {
        return Err(bad("not a packfile"));
    }
    let version = u32::from_be_bytes(pack[4..8].try_into().unwrap());
    if version != 2 && version != 3 {
        return Err(bad(&format!("version {version}")));
    }
    let count = u32::from_be_bytes(pack[8..12].try_into().unwrap()) as usize;
    let mut h = Sha1::new();
    h.update(&pack[..pack.len() - 20]);
    if h.finalize().as_slice() != &pack[pack.len() - 20..] {
        return Err(bad("checksum mismatch"));
    }
    let mut pos = 12;
    let mut raws: Vec<Raw> = Vec::with_capacity(count);
    let mut at_offset: HashMap<usize, usize> = HashMap::new();
    for i in 0..count {
        let start = pos;
        let mut c = *pack.get(pos).ok_or_else(|| bad("truncated"))?;
        pos += 1;
        let t = (c >> 4) & 7;
        let mut size = (c & 0x0f) as usize;
        let mut shift = 4;
        while c & 0x80 != 0 {
            c = *pack.get(pos).ok_or_else(|| bad("truncated"))?;
            pos += 1;
            size |= ((c & 0x7f) as usize) << shift;
            shift += 7;
        }
        let raw = match t {
            1..=4 => {
                let (body, used) = inflate_at(&pack[pos..], size)?;
                pos += used;
                Raw::Full(ObjType::from_code(t).unwrap(), body)
            }
            6 => {
                let mut c = pack[pos];
                pos += 1;
                let mut off = (c & 0x7f) as usize;
                while c & 0x80 != 0 {
                    c = pack[pos];
                    pos += 1;
                    off = ((off + 1) << 7) | (c & 0x7f) as usize;
                }
                let base = start.checked_sub(off).ok_or_else(|| bad("bad delta offset"))?;
                let (delta, used) = inflate_at(&pack[pos..], size)?;
                pos += used;
                Raw::OfsDelta(base, delta)
            }
            7 => {
                let base: Oid = pack.get(pos..pos + 20).ok_or_else(|| bad("truncated"))?.try_into().unwrap();
                pos += 20;
                let (delta, used) = inflate_at(&pack[pos..], size)?;
                pos += used;
                Raw::RefDelta(base, delta)
            }
            _ => return Err(bad(&format!("object type {t}"))),
        };
        at_offset.insert(start, i);
        raws.push(raw);
    }
    // Resolve deltas; bases may come later in the pack (REF_DELTA), so loop until done.
    let mut resolved: Vec<Option<(ObjType, Vec<u8>)>> = vec![None; count];
    let mut by_oid: HashMap<Oid, usize> = HashMap::new();
    loop {
        let mut progress = false;
        let mut pending = 0;
        for i in 0..count {
            if resolved[i].is_some() {
                continue;
            }
            let r = match &raws[i] {
                Raw::Full(t, b) => Some((*t, b.clone())),
                Raw::OfsDelta(base, d) => {
                    let bi = *at_offset.get(base).ok_or_else(|| bad("delta base not at an object"))?;
                    match &resolved[bi] {
                        Some((t, b)) => Some((*t, apply_delta(b, d)?)),
                        None => None,
                    }
                }
                Raw::RefDelta(base, d) => match by_oid.get(base).and_then(|bi| resolved[*bi].as_ref()) {
                    Some((t, b)) => Some((*t, apply_delta(b, d)?)),
                    None => None,
                },
            };
            match r {
                Some((t, b)) => {
                    by_oid.insert(object_id(t, &b), i);
                    resolved[i] = Some((t, b));
                    progress = true;
                }
                None => pending += 1,
            }
        }
        if pending == 0 {
            break;
        }
        if !progress {
            return Err(bad(&format!("{pending} deltas against objects not in the pack (thin pack?)")));
        }
    }
    Ok(resolved.into_iter().map(|r| r.unwrap()).collect())
}

fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>> {
    let bad = || GfsError::Other("pack: corrupt delta".into());
    let mut i = 0;
    let mut varint = |i: &mut usize| -> Result<usize> {
        let mut v = 0usize;
        let mut shift = 0;
        loop {
            let c = *delta.get(*i).ok_or_else(bad)?;
            *i += 1;
            v |= ((c & 0x7f) as usize) << shift;
            shift += 7;
            if c & 0x80 == 0 {
                return Ok(v);
            }
        }
    };
    let src = varint(&mut i)?;
    let dst = varint(&mut i)?;
    if src != base.len() {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(dst);
    while i < delta.len() {
        let op = delta[i];
        i += 1;
        if op & 0x80 != 0 {
            let mut off = 0usize;
            let mut len = 0usize;
            for k in 0..4 {
                if op & (1 << k) != 0 {
                    off |= (*delta.get(i).ok_or_else(bad)? as usize) << (8 * k);
                    i += 1;
                }
            }
            for k in 0..3 {
                if op & (0x10 << k) != 0 {
                    len |= (*delta.get(i).ok_or_else(bad)? as usize) << (8 * k);
                    i += 1;
                }
            }
            if len == 0 {
                len = 0x10000;
            }
            out.extend_from_slice(base.get(off..off + len).ok_or_else(bad)?);
        } else if op != 0 {
            let n = op as usize;
            out.extend_from_slice(delta.get(i..i + n).ok_or_else(bad)?);
            i += n;
        } else {
            return Err(bad());
        }
    }
    if out.len() != dst {
        return Err(bad());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Author;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_NOSYSTEM", "1").env("HOME", dir).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_stdin(dir: &Path, args: &[&str], input: &[u8]) -> String {
        use std::io::Write;
        let mut child = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("HOME", dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gfs-git-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn known_ids() {
        assert_eq!(hex_oid(&object_id(ObjType::Blob, b"")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(hex_oid(&object_id(ObjType::Blob, b"hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(hex_oid(&object_id(ObjType::Tree, b"")), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }

    fn sample() -> (Datacombs, String) {
        let mut d = Datacombs::new("node-a");
        d.create_comb("ws", Author { session: "s1".into(), harness: "pi".into(), model: "mock/x".into(), principal: "user".into() }, 1_700_000_000_000).unwrap();
        // names chosen to exercise git's "directories sort with a trailing slash" rule
        for (p, c) in [("a", "dir file"), ("a-b", "1"), ("a.b", "2"), ("a0", "3"), ("z/y/x.txt", "deep\n"), ("empty", "")] {
            let p = if p == "a" { "a/inner.txt" } else { p };
            d.write_file("ws", p, c.as_bytes().to_vec()).unwrap();
        }
        d.write_file("ws", "run.sh", b"#!/bin/sh\necho hi\n".to_vec()).unwrap();
        let id = d
            .commit(
                "ws",
                EntryKind::ToolCall { tool_call_id: "call-1".into(), turn_id: "t1".into(), tool_name: "write".into(), args_hash: None },
                Author { session: "s1".into(), harness: "pi".into(), model: "mock/x".into(), principal: "user".into() },
                1_700_000_100_000,
            )
            .unwrap()
            .unwrap();
        (d, id)
    }

    #[test]
    fn tree_matches_git_write_tree() {
        let (d, id) = sample();
        let mut g = GitCache::default();
        let mut ov = Overlay::new();
        ov.insert("run.sh".into(), Special::Mode("100755".into()));
        let ours = d.git_encode_entry_tree(&mut g, &id, &ov).unwrap();
        let dir = tmp("tree");
        git(&dir, &["init", "-q"]);
        for (p, h) in d.list_all("ws").unwrap().into_iter().map(|(p, _, _)| (p.clone(), d.read_file("ws", &p).unwrap())) {
            let f = dir.join(&p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, h).unwrap();
        }
        git(&dir, &["add", "-A"]);
        git(&dir, &["update-index", "--chmod=+x", "run.sh"]);
        assert_eq!(ours, git(&dir, &["write-tree"]));
    }

    #[test]
    fn pack_is_accepted_by_git_and_roundtrips() {
        let (d, id) = sample();
        let mut g = GitCache::default();
        let ov = Overlay::new();
        let genesis = d.log("ws").unwrap().last().unwrap().id.clone();
        let c0 = d.git_encode_entry(&mut g, &genesis, &[], ("node-a", "node-a@gfs.invalid"), &ov).unwrap();
        let c1 = d.git_encode_entry(&mut g, &id, &[parse_oid(&c0.commit).unwrap()], ("node-a", "node-a@gfs.invalid"), &ov).unwrap();
        let pack = g.build_pack(&d.store, &[parse_oid(&c0.commit).unwrap(), parse_oid(&c1.commit).unwrap()], &[]).unwrap();
        let dir = tmp("pack");
        git(&dir, &["init", "-q", "--bare"]);
        git_stdin(&dir, &["index-pack", "--stdin", "--strict"], &pack);
        git(&dir, &["update-ref", "refs/heads/main", &c1.commit]);
        git(&dir, &["fsck", "--strict", "--no-dangling"]);
        let msg = git(&dir, &["log", "-1", "--format=%an <%ae>%n%cn%n%B", "main"]);
        assert!(msg.starts_with("pi (mock/x) <s1@node-a>\nnode-a\nwrite: 7 added"), "{msg}");
        assert!(msg.contains(&format!("Gfs-Entry: {id}")), "{msg}");
        assert!(msg.contains("Gfs-Tool-Call: call-1"));
        assert_eq!(git(&dir, &["show", "main:z/y/x.txt"]), "deep");
        // A second push only needs what the remote doesn't have.
        let mut d = d;
        d.write_file("ws", "z/y/x.txt", b"deeper\n".to_vec()).unwrap();
        let id2 = d.commit("ws", EntryKind::External, Author::default(), 1_700_000_200_000).unwrap().unwrap();
        let c2 = d.git_encode_entry(&mut g, &id2, &[parse_oid(&c1.commit).unwrap()], ("node-a", "e"), &ov).unwrap();
        let thin = g.build_pack(&d.store, &[parse_oid(&c2.commit).unwrap()], &[parse_oid(&c1.tree).unwrap()]).unwrap();
        let n = u32::from_be_bytes(thin[8..12].try_into().unwrap());
        assert_eq!(n, 5, "commit + root, z, z/y trees + one blob");
        git_stdin(&dir, &["index-pack", "--stdin", "--strict"], &thin);
        git(&dir, &["update-ref", "refs/heads/main", &c2.commit, &c1.commit]);
        git(&dir, &["fsck", "--strict", "--no-dangling"]);
        assert_eq!(git(&dir, &["show", "main:z/y/x.txt"]), "deeper");
    }

    #[test]
    fn parses_git_packs_with_deltas_and_checks_out() {
        let dir = tmp("deltas");
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t"]);
        let big: String = (0..2000).map(|i| format!("line {i} of a file that will be deltified\n")).collect();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/big.txt"), &big).unwrap();
        std::fs::write(dir.join("tool.sh"), "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("tool.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "one"]);
        std::fs::write(dir.join("src/big.txt"), format!("{big}one more line\n")).unwrap();
        git(&dir, &["commit", "-q", "-am", "two"]);
        // a symlink and a submodule entry
        std::os::unix::fs::symlink("src/big.txt", dir.join("link")).unwrap();
        git(&dir, &["add", "link"]);
        git(&dir, &["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,vendor/lib"]);
        git(&dir, &["commit", "-q", "-m", "three"]);
        let head = git(&dir, &["rev-parse", "HEAD"]);
        let list = git(&dir, &["rev-list", "--objects", "HEAD"]);
        let out = {
            use std::io::Write;
            let mut child = Command::new("git")
                .args(["pack-objects", "--stdout", "--revs", "--delta-base-offset"])
                .current_dir(&dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(b"HEAD\n").unwrap();
            child.wait_with_output().unwrap().stdout
        };
        let mut d = Datacombs::new("node-b");
        d.create_comb("ws", Author::default(), 1).unwrap();
        let mut g = GitCache::default();
        let objs = g.index_pack(&mut d.store, &out).unwrap();
        let want: HashSet<String> = list.lines().map(|l| l.split(' ').next().unwrap().to_string()).collect();
        let got: HashSet<String> = objs.iter().map(|(_, o)| hex_oid(o)).collect();
        assert_eq!(got, want);
        let ov = d.git_checkout(&g, "ws", &parse_oid(&head).unwrap()).unwrap();
        assert_eq!(d.read_file("ws", "src/big.txt").unwrap(), format!("{big}one more line\n").as_bytes());
        assert_eq!(d.read_file("ws", "link").unwrap(), b"src/big.txt");
        assert_eq!(ov.get("tool.sh"), Some(&Special::Mode("100755".into())));
        assert_eq!(ov.get("link"), Some(&Special::Mode("120000".into())));
        assert!(matches!(ov.get("vendor/lib"), Some(Special::Gitlink(_))));
        // Imported then re-encoded, the tree is git's tree, byte for byte.
        let id = d.commit("ws", EntryKind::External, Author::default(), 2).unwrap().unwrap();
        let tree = d.git_encode_entry_tree(&mut g, &id, &ov).unwrap();
        assert_eq!(tree, git(&dir, &["rev-parse", "HEAD^{tree}"]));
    }
}
