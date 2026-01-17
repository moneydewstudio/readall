// Simple Promise-based IDB wrapper
const DB_NAME = 'readall_db';
const STORE_BOOKS = 'books';
const DB_VERSION = 1;

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      }
    };
  });
};

export const saveBookToDB = async (book: any) => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);
    const request = store.put(book);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getBooksFromDB = async (): Promise<any[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const store = tx.objectStore(STORE_BOOKS);
    const request = store.getAll();
    request.onsuccess = () => {
        // Ensure we always return an array, even if the result is undefined/null
        const result = request.result;
        resolve(Array.isArray(result) ? result : []);
    };
    request.onerror = () => reject(request.error);
  });
};

export const deleteBookFromDB = async (id: string) => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    const store = tx.objectStore(STORE_BOOKS);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};