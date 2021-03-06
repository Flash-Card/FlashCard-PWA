import * as CONFIG from 'config';
import SCHEMA from './schema';
import { arrayRange } from 'lib/helpers';
import Api from 'domain/api';
import { searcher } from './searcher';

const READ_ONLY = 'readonly';
const READ_WRITE = 'readwrite';

export const TABLE = CONFIG.TABLES;

/**
 * helpers
 * */

function rejectify(request, reject) {
  request.onerror = function() {
    reject(this.error);
  };
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    rejectify(request, reject);
    request.onsuccess = function() {
      resolve(this.result);
    };
  });
}

const nextCursor = (resolve, max) => {
  if (typeof max === 'number') {
    return function(list) {
      if (list.length < max) {
        this.result.continue();
      } else {
        resolve(list);
      }
    };
  }
  return function() {
    this.result.continue();
  };
};

function promiSeq(cursor, max) {
  let list = [];
  return new Promise((resolve, reject) => {
    const next = nextCursor(resolve, max);
    cursor.onsuccess = function() {
      if (this.result) {
        list = list.concat(this.result.value);
        next.call(this, list);
      } else {
        resolve(list);
      }
    };
    rejectify(cursor, reject);
  });
}

export function updateIndex(table) {
  return ({ transaction }, { name, keyPath, option }) => {
    const objectStore = transaction.objectStore(table);
    if (objectStore.indexNames.contains(name)) {
      objectStore.deleteIndex(name);
    }
    objectStore.createIndex(name, keyPath, option);
  };
}


/**
 * DB helpers
 * */

function tableExist(db, table) {
  const osn = db.objectStoreNames;
  for (let i = 0; i < osn.length; i++) {
    if (osn[i] === table) return true;
  }
  return false;
}

function add(db, table) {
  return item => promisify(os(db, table, READ_WRITE).add(item));
}

function put(db, table, modifier = d => d) {
  return (item, i) => promisify(os(db, table, READ_WRITE).put(modifier(item, i)));
}

export function os(db, table, permission) {
  if (tableExist(db, table)) { return db.transaction([table], permission).objectStore(table); }
  throw new Error(`Table ${table} is not exist`);
}

export function getList(db, table) {
  if (tableExist(db, table)) {
    return promiSeq(os(db, table, READ_ONLY).openCursor());
  } return Promise.reject(`Table ${table} is not exist in object store`);
}

export function updateList(db, table, modifier) {
  return new Promise((resolve, reject) => {
    let res = [];
    const store = os(db, table, READ_WRITE).openCursor();

    store.onsuccess = function() {
      const cursor = this.result;
      if (cursor) {
        const request = cursor.update(modifier(cursor.value));
        request.onsuccess = function() {
          res = res.concat([this.result]);
        };
        cursor.continue();
      } else {
        resolve(res);
      }
    };

    store.onerror = function() {
      reject(this.error);
    };

  });
}

export function upgrade({ getFixtures, schema }) {
  return function(event) {
    const { newVersion, oldVersion } = event;

    arrayRange(newVersion).slice(oldVersion).forEach((idx) => {

      schema[idx + 1].forEach((item) => {

        if (typeof item.fixture !== 'undefined') {
          this.setAsync(db =>
            getFixtures({ name: item.fixture, pathname: global.location.pathname })
              .then(({ data: { name, values } }) => iterator(values, os(db, name, READ_WRITE), 'add')),
          );
        }

        if (typeof item.syncAction === 'function') {
          item.syncAction.call(this, event, item.name);
        }

        if (typeof item.asyncAction === 'function') {
          this.setAsync(item.asyncAction);
        }

      });
    });
  };
}


export function OpenDB(config, onUpgrade) {
  let async = [];

  this.setAsync = (value) => {
    async = async.concat(value);
  };

  const request = indexedDB.open(config.DB_NAME, config.DB_VERSION);

  request.onupgradeneeded = onUpgrade.bind(this);

  return promisify(request)
    .then((db) => {
      if (async.length) {
        return Promise.all(async.map(fn => fn(db))).then(() => db);
      }
      return db;
    });
}

/**
 *
 * */

const iDB = (getFixtures = Api.fixtures, schema = SCHEMA) => new OpenDB(CONFIG, upgrade({ getFixtures, schema }));

export function getItem(table, indexName, value, idb = iDB) {
  return idb()
    .then(db => promisify(
      os(db, table, READ_ONLY).index(indexName).get(value)),
    );
}

export function getListByIndex(table, indexName, value, idb = iDB) {
  return idb()
    .then(db => promiSeq(
      os(db, table, READ_ONLY)
        .index(indexName)
        .openCursor(IDBKeyRange.only(value)),
    ));
}

export function getCard(set, key, idb = iDB) {
  return idb()
    .then(db =>
      promisify(os(db, TABLE.DICTIONARY, READ_ONLY).get([set, key])),
    );
}

export function getNeighbor(set, index, idb = iDB) {
  const neighbor = el => (el ? el.value : null);
  return idb()
    .then((db) => {
      const store = os(db, TABLE.DICTIONARY, READ_ONLY).index('index');
      const upperBound = IDBKeyRange.only([set, index - 1]);
      const lowerBound = IDBKeyRange.only([set, index + 1]);
      return Promise.all([
        promisify(store.openCursor(upperBound)).then(neighbor),
        promisify(store.openCursor(lowerBound)).then(neighbor),
      ]);
    });
}

export function addItem(table, item, idb = iDB) {
  return idb()
    .then(db => add(db, table)(item));
}

function iterator(arr, objectStore, actionName, progress = () => null) {
  return new Promise((resolve, reject) => {
    threadAction(arr, objectStore, actionName, resolve, reject, progress);
  });
}

function threadAction(arr, objectStore, actionName, resolve, reject, progress) {
  const set = new Set(arr);

  let res = [];

  const si = setInterval(() => { progress(res.length / arr.length); }, 300);

  let count = set.size >= 6 ? 5 : set.size - 1; /** Count of thread - 1 */
  const it = set.keys();

  const nx = function(event) {
    if (event) {
      res = res.concat([this.result]);
    }
    const n = it.next();
    if (!n.done) {
      const storeItem = objectStore[actionName](n.value);
      storeItem.onsuccess = nx;
      storeItem.onerror = reject;
      ++count;
    } else if (count === 0) {
      clearInterval(si);
      progress(res.length / arr.length);
      resolve(res);
    }
    --count;
  };

  for (let i = 0; i <= count; i++) {
    nx();
  }
}

export function addList(table, list, { idb = iDB, progress } = {}) {
  return idb()
    .then(db => iterator(list, os(db, table, READ_WRITE), 'add', progress));
}

export function updateItem(table, item, idb = iDB) {
  return idb()
    .then(db => put(db, table)(item));
}

export function deleteItem(table, index, idb = iDB) {
  return idb()
    .then(db => promisify(os(db, table, READ_WRITE).delete(index)));
}

export function count(table, idb = iDB) {
  return idb()
    .then(db => promisify(os(db, table, READ_ONLY).count()));
}

export function version(idb = iDB) {
  return idb().then(db => db.version);
}

export function clean(idb = iDB) {
  return idb()
    .then((db) => {
      db.close();
      return promisify(global.indexedDB.deleteDatabase(CONFIG.DB_NAME));
    });
}

export function fillStore({ STORE_TABLES }, idb = iDB) {
  const tables = STORE_TABLES;
  return idb()
    .then((db) => {
      const isExist = t => tableExist(db, t);
      const tList = t => getList(db, t);
      return Promise.all(
        tables.reduce((A, t) => (isExist(t) ? A.concat([tList(t)]) : A), []),
      );
    })
    .then(list => list.reduce((A, V, I) => ({ ...A, [tables[I]]: V }), {}));
}

export function searchByQuery(query, idb = iDB) {
  return idb()
    .then((db) => {
      const store = os(db, 'dictionary', READ_ONLY).index('keyName');
      return promiSeq(store.openCursor(IDBKeyRange.bound(query, `${query}\uffff`), IDBCursor.PREV), 10);
    });
}

export function searchWithSpellCheck(word, idb = iDB) {
  return idb()
    .then((db) => {
      const store = os(db, 'dictionary', READ_ONLY);
      return searcher(store, word);
    });
}
