/**
 * Storage seam: a generic collection store so routes and domain modules
 * never lock to a storage implementation (P4/P9/P12 add Resource/Source/
 * progress/notes collections on the same seam).
 *
 * createFileStore is the round-1 embedded implementation: one JSON file,
 * in-memory maps, write-through with an atomic tmp+rename save. Collections
 * are opaque named maps; the store knows nothing about domains.
 */
const fs = require("node:fs");
const path = require("node:path");

function createFileStore({ file }) {
  const collections = new Map();

  function load() {
    if (!fs.existsSync(file)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, entries] of Object.entries(raw)) {
      const map = new Map(Object.entries(entries));
      collections.set(name, map);
    }
  }

  function save() {
    const snapshot = {};
    for (const [name, map] of collections) {
      snapshot[name] = Object.fromEntries(map);
    }
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, file);
  }

  load();

  function collectionFor(name) {
    let map = collections.get(name);
    if (!map) {
      map = new Map();
      collections.set(name, map);
    }
    return map;
  }

  return {
    /** Get one record or null. */
    get(collection, key) {
      const value = collectionFor(collection).get(key);
      return value === undefined ? null : value;
    },
    /** Insert or replace one record. */
    set(collection, key, value) {
      collectionFor(collection).set(key, value);
      save();
    },
    /** Remove one record; returns true when it existed. */
    delete(collection, key) {
      const existed = collectionFor(collection).delete(key);
      if (existed) {
        save();
      }
      return existed;
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

module.exports = { createFileStore };
