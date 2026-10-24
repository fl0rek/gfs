//! PROTOTYPE. wasm-bindgen surface of datacombs for the browser worker.
//!
//! All results are JSON-serializable JS values; errors are thrown as strings.

pub mod combs;
pub mod model;
pub mod store;

use combs::{Datacombs, GfsError};
use model::{Author, EntryKind};
use wasm_bindgen::prelude::*;

type JsResult<T> = Result<T, JsValue>;

fn js<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn to_js<T: serde::Serialize>(v: &T) -> JsResult<JsValue> {
    serde_wasm_bindgen_lite::to_value(v)
}

/// Minimal serde→JsValue via JSON (keeps the dependency list short).
mod serde_wasm_bindgen_lite {
    use super::*;
    pub fn to_value<T: serde::Serialize>(v: &T) -> JsResult<JsValue> {
        let s = serde_json::to_string(v).map_err(js)?;
        js_sys::JSON::parse(&s)
    }
    pub fn from_value<T: serde::de::DeserializeOwned>(v: JsValue) -> JsResult<T> {
        let s: String = js_sys::JSON::stringify(&v)?.into();
        serde_json::from_str(&s).map_err(js)
    }
}

#[wasm_bindgen]
pub struct Gfs {
    inner: Datacombs,
}

#[wasm_bindgen]
impl Gfs {
    #[wasm_bindgen(constructor)]
    pub fn new(node: &str) -> Gfs {
        Gfs { inner: Datacombs::new(node) }
    }

    // ----- persistence (host drives it) -----

    /// Load an object that was persisted earlier. `hash` must be its id.
    #[wasm_bindgen(js_name = importObject)]
    pub fn import_object(&mut self, hash: &str, bytes: &[u8]) {
        self.inner.store.put_hashed(hash.to_string(), bytes.to_vec(), false);
    }

    #[wasm_bindgen(js_name = importRef)]
    pub fn import_ref(&mut self, name: &str, hash: &str) {
        self.inner.store.set_ref(name, hash.to_string(), false);
    }

    /// Rebuild working trees from heads after importing.
    #[wasm_bindgen(js_name = checkoutAll)]
    pub fn checkout_all(&mut self) -> JsResult<()> {
        self.inner.checkout_all().map_err(js)
    }

    /// New objects since the last drain: `[{hash, bytes: Uint8Array}]`.
    #[wasm_bindgen(js_name = drainNewObjects)]
    pub fn drain_new_objects(&mut self) -> JsResult<JsValue> {
        let arr = js_sys::Array::new();
        for (h, b) in self.inner.store.drain_new_objects() {
            let o = js_sys::Object::new();
            js_sys::Reflect::set(&o, &"hash".into(), &h.into())?;
            js_sys::Reflect::set(&o, &"bytes".into(), &js_sys::Uint8Array::from(b.as_slice()).into())?;
            arr.push(&o);
        }
        Ok(arr.into())
    }

    /// Refs changed since the last drain: `[{name, hash}]`.
    #[wasm_bindgen(js_name = drainNewRefs)]
    pub fn drain_new_refs(&mut self) -> JsResult<JsValue> {
        let v: Vec<serde_json::Value> = self
            .inner
            .store
            .drain_new_refs()
            .into_iter()
            .map(|(n, h)| serde_json::json!({"name": n, "hash": h}))
            .collect();
        to_js(&v)
    }

    #[wasm_bindgen(js_name = objectCount)]
    pub fn object_count(&self) -> usize {
        self.inner.store.object_count()
    }

    // ----- combs -----

    #[wasm_bindgen(js_name = listCombs)]
    pub fn list_combs(&self) -> JsResult<JsValue> {
        to_js(&self.inner.list_combs())
    }

    #[wasm_bindgen(js_name = createComb)]
    pub fn create_comb(&mut self, comb: &str, author: JsValue, time: f64) -> JsResult<String> {
        let author: Author = serde_wasm_bindgen_lite::from_value(author)?;
        self.inner.create_comb(comb, author, time as u64).map_err(js)
    }

    #[wasm_bindgen(js_name = hasComb)]
    pub fn has_comb(&self, comb: &str) -> bool {
        self.inner.head(comb).is_ok()
    }

    pub fn head(&self, comb: &str) -> JsResult<String> {
        self.inner.head(comb).map_err(js)
    }

    // ----- working tree -----

    #[wasm_bindgen(js_name = readFile)]
    pub fn read_file(&self, comb: &str, path: &str) -> JsResult<Vec<u8>> {
        self.inner.read_file(comb, path).map_err(js)
    }

    #[wasm_bindgen(js_name = writeFile)]
    pub fn write_file(&mut self, comb: &str, path: &str, bytes: &[u8]) -> JsResult<()> {
        self.inner.write_file(comb, path, bytes.to_vec()).map_err(js)
    }

    pub fn remove(&mut self, comb: &str, path: &str) -> JsResult<usize> {
        self.inner.remove(comb, path).map_err(js)
    }

    pub fn rename(&mut self, comb: &str, from: &str, to: &str) -> JsResult<()> {
        self.inner.rename(comb, from, to).map_err(js)
    }

    pub fn stat(&self, comb: &str, path: &str) -> JsResult<JsValue> {
        to_js(&self.inner.stat(comb, path).map_err(js)?)
    }

    pub fn exists(&self, comb: &str, path: &str) -> bool {
        self.inner.stat(comb, path).is_ok()
    }

    #[wasm_bindgen(js_name = listDir)]
    pub fn list_dir(&self, comb: &str, path: &str) -> JsResult<JsValue> {
        to_js(&self.inner.list_dir(comb, path).map_err(js)?)
    }

    /// `[[path, hash, size], ...]` for every file in the working tree.
    #[wasm_bindgen(js_name = listAll)]
    pub fn list_all(&self, comb: &str) -> JsResult<JsValue> {
        to_js(&self.inner.list_all(comb).map_err(js)?)
    }

    /// Discard the working tree's changes: back to head's tree.
    #[wasm_bindgen(js_name = resetWorking)]
    pub fn reset_working(&mut self, comb: &str) -> JsResult<()> {
        self.inner.reset_working(comb).map_err(js)
    }

    /// Changes in the working tree relative to head.
    pub fn status(&self, comb: &str) -> JsResult<JsValue> {
        to_js(&self.inner.status(comb).map_err(js)?)
    }

    // ----- history -----

    /// Store tool-call arguments (or any bytes) by hash. Returns the hash.
    #[wasm_bindgen(js_name = putBlob)]
    pub fn put_blob(&mut self, bytes: &[u8]) -> String {
        self.inner.put_blob(bytes.to_vec())
    }

    /// Commit the working tree as a history entry.
    /// `kind` is `{kind: "tool_call", tool_call_id, turn_id, tool_name, args_hash}`
    /// or `{kind: "turn", turn_id}` or `{kind: "external"}`.
    /// Returns the entry id, or null when nothing changed.
    pub fn commit(&mut self, comb: &str, kind: JsValue, author: JsValue, time: f64) -> JsResult<Option<String>> {
        let kind: EntryKind = serde_wasm_bindgen_lite::from_value(kind)?;
        let author: Author = serde_wasm_bindgen_lite::from_value(author)?;
        self.inner.commit(comb, kind, author, time as u64).map_err(js)
    }

    /// Newest first: `[{id, comb, parent, tree, kind, ..., author, time, message, summary}]`.
    pub fn log(&self, comb: &str) -> JsResult<JsValue> {
        to_js(&self.inner.log(comb).map_err(js)?)
    }

    pub fn entry(&self, id: &str) -> JsResult<JsValue> {
        to_js(&self.inner.entry(id).map_err(js)?)
    }

    /// Files changed by an entry relative to its parent.
    #[wasm_bindgen(js_name = diffEntry)]
    pub fn diff_entry(&self, id: &str) -> JsResult<JsValue> {
        to_js(&self.inner.diff_entry(id).map_err(js)?)
    }

    #[wasm_bindgen(js_name = diffEntries)]
    pub fn diff_entries(&self, a: &str, b: &str) -> JsResult<JsValue> {
        to_js(&self.inner.diff_entries(a, b).map_err(js)?)
    }

    #[wasm_bindgen(js_name = unifiedDiff)]
    pub fn unified_diff(&self, path: &str, old_hash: Option<String>, new_hash: Option<String>) -> JsResult<String> {
        self.inner.unified_diff(path, old_hash.as_deref(), new_hash.as_deref()).map_err(js)
    }

    #[wasm_bindgen(js_name = readFileAt)]
    pub fn read_file_at(&self, entry_id: &str, path: &str) -> JsResult<Vec<u8>> {
        self.inner.read_file_at(entry_id, path).map_err(js)
    }

    #[wasm_bindgen(js_name = listDirAt)]
    pub fn list_dir_at(&self, entry_id: &str, path: &str) -> JsResult<JsValue> {
        to_js(&self.inner.list_dir_at(entry_id, path).map_err(js)?)
    }

    #[wasm_bindgen(js_name = listAllAt)]
    pub fn list_all_at(&self, entry_id: &str) -> JsResult<JsValue> {
        to_js(&self.inner.list_all_at(entry_id).map_err(js)?)
    }

    pub fn blob(&self, hash: &str) -> JsResult<Vec<u8>> {
        self.inner.blob(hash).map_err(js)
    }

    /// Append a rollback entry whose tree is `to_entry`'s tree. Returns the new entry id.
    pub fn rollback(&mut self, comb: &str, to_entry: &str, author: JsValue, time: f64) -> JsResult<String> {
        let author: Author = serde_wasm_bindgen_lite::from_value(author)?;
        self.inner.rollback(comb, to_entry, author, time as u64).map_err(js)
    }

    /// `{ok, entries, objects_checked, problems: [..]}`
    pub fn verify(&self, comb: &str) -> JsResult<JsValue> {
        to_js(&self.inner.verify(comb).map_err(js)?)
    }
}

impl From<GfsError> for JsValue {
    fn from(e: GfsError) -> JsValue {
        js(e)
    }
}
