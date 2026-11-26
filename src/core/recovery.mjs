// SPDX-License-Identifier: MIT
// A completed IndexedDB transaction is required before an online write begins.
const DB_NAME = 'uv-k10pro-web-recovery';
async function database() {
  if (!globalThis.indexedDB) throw new Error('当前浏览器无法保存写前恢复快照，未开始写入。');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开恢复存储：' + request.error?.message));
    request.onblocked = () => reject(new Error('恢复存储被另一个页面占用，请关闭旧工作台后重试。'));
  });
}
export async function saveRecovery(project) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('snapshots', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('snapshots');
      store.add({ time: new Date().toISOString(), project });
      const ids = store.getAllKeys();
      ids.onsuccess = () => ids.result.slice(0, Math.max(0, ids.result.length - 5)).forEach(id => store.delete(id));
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(new Error('写前备份保存失败，未开始设备写入：' + transaction.error?.message));
    });
  } finally { db.close(); }
}
export async function latestRecovery() {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('snapshots').objectStore('snapshots').openCursor(null, 'prev');
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
