/**
 * Storage seam: a generic collection store so routes and domain modules
 * never lock to a storage implementation (P4/P9/P12 add Resource/Source/
 * progress/notes collections on the same seam).
 *
 * Two implementations, one interface:
 * - createFileStore: round-1 embedded persistence, one JSON file,
 *   in-memory maps, write-through with an atomic tmp+rename save.
 * - createMemoryStore: no persistence (app default; tests use it too).
 * Collections are opaque named maps; the store knows nothing about domains.
 */
const fs = require("node:fs");
const path = require("node:path");

function createStore() {
  const collections = new Map();

  function collectionFor(name) {
    let map = collections.get(name);
    if (!map) {
      map = new Map();
      collections.set(name, map);
    }
    return map;
  }

  return {
    collections,
    /** Get one record or null. */
    get(collection, key) {
      const value = collectionFor(collection).get(key);
      return value === undefined ? null : value;
    },
    /** Insert or replace one record. */
    set(collection, key, value) {
      collectionFor(collection).set(key, value);
    },
    /** Remove one record; returns true when it existed. */
    delete(collection, key) {
      return collectionFor(collection).delete(key);
    },
    /** All records of a collection, insertion-ordered. */
    list(collection) {
      return [...collectionFor(collection).values()];
    },
    count(collection) {
      return collectionFor(collection).size;
    },
  };
}

function createMemoryStore() {
  return createStore();
}

function createFileStore({ file }) {
  const store = createStore();

  function load() {
    if (!fs.existsSync(file)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, entries] of Object.entries(raw)) {
      store.collections.set(name, new Map(Object.entries(entries)));
    }
  }

  function save() {
    const snapshot = {};
    for (const [name, map] of store.collections) {
      snapshot[name] = Object.fromEntries(map);
    }
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, file);
  }

  load();

  // Wrap mutations with the atomic save.
  return {
    get: store.get,
    list: store.list,
    count: store.count,
    set(collection, key, value) {
      store.set(collection, key, value);
      save();
    },
    delete(collection, key) {
      const existed = store.delete(collection, key);
      if (existed) {
        save();
      }
      return existed;
    },
  };
}

module.exports = { createFileStore, createMemoryStore };
