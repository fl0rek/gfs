//! PROTOTYPE. In-memory object store with a write log, so the host (JS) can
//! persist new objects (to OPFS) after each operation and feed them back on load.

use crate::model::{hash_bytes, Hash};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
pub struct Store {
    objects: HashMap<Hash, Vec<u8>>,
    refs: BTreeMap<String, Hash>,
    /// Objects written since the last drain, in write order.
    new_objects: Vec<Hash>,
    /// Refs changed since the last drain.
    new_refs: Vec<String>,
}

impl Store {
    pub fn get(&self, hash: &str) -> Option<&[u8]> {
        self.objects.get(hash).map(|v| v.as_slice())
    }

    pub fn has(&self, hash: &str) -> bool {
        self.objects.contains_key(hash)
    }

    /// Store bytes under a domain. Returns the hash. Idempotent.
    pub fn put(&mut self, domain: &str, bytes: Vec<u8>) -> Hash {
        let h = hash_bytes(domain, &bytes);
        self.put_hashed(h.clone(), bytes, true);
        h
    }

    /// Store bytes under an already-known hash (used when loading from disk).
    pub fn put_hashed(&mut self, hash: Hash, bytes: Vec<u8>, log: bool) {
        if !self.objects.contains_key(&hash) {
            if log {
                self.new_objects.push(hash.clone());
            }
            self.objects.insert(hash, bytes);
        }
    }

    pub fn get_ref(&self, name: &str) -> Option<&Hash> {
        self.refs.get(name)
    }

    pub fn set_ref(&mut self, name: &str, hash: Hash, log: bool) {
        if log {
            self.new_refs.push(name.to_string());
        }
        self.refs.insert(name.to_string(), hash);
    }

    pub fn refs(&self) -> impl Iterator<Item = (&String, &Hash)> {
        self.refs.iter()
    }

    pub fn drain_new_objects(&mut self) -> Vec<(Hash, Vec<u8>)> {
        let names = std::mem::take(&mut self.new_objects);
        names
            .into_iter()
            .filter_map(|h| self.objects.get(&h).map(|b| (h.clone(), b.clone())))
            .collect()
    }

    pub fn drain_new_refs(&mut self) -> Vec<(String, Hash)> {
        let mut names = std::mem::take(&mut self.new_refs);
        names.sort();
        names.dedup();
        names
            .into_iter()
            .filter_map(|n| self.refs.get(&n).map(|h| (n.clone(), h.clone())))
            .collect()
    }

    pub fn object_count(&self) -> usize {
        self.objects.len()
    }
}
