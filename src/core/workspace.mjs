// SPDX-License-Identifier: MIT
import { PROFILE, isWritableRange, regionAt } from './profile.mjs';
import { bytes, integer, hex } from './encoding.mjs';

export function normalizeCoverage(ranges, capacity = PROFILE.capacity) {
  if (!Array.isArray(ranges) || ranges.length > 4096) throw new RangeError('Invalid coverage list');
  const result = [];
  for (const range of ranges.map(r => ({ address: r.address, length: r.length })).sort((a, b) => a.address - b.address)) {
    integer(range.address, 0, capacity - 1, 'coverage address');
    integer(range.length, 1, capacity - range.address, 'coverage length');
    const previous = result.at(-1);
    if (previous && range.address <= previous.address + previous.length)
      previous.length = Math.max(previous.address + previous.length, range.address + range.length) - previous.address;
    else result.push(range);
  }
  return result;
}
export function covers(ranges, address, length) {
  return Number.isSafeInteger(address) && Number.isSafeInteger(length) && length > 0 &&
    ranges.some(r => address >= r.address && address + length <= r.address + r.length);
}
export function equalBytes(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

export class MemoryWorkspace {
  constructor({ name = '未命名工作区', mode = 'offline', data, baseline = data, coverage,
    sessionId = null, provenance = {}, importedDirty = false } = {}) {
    if (!['offline', 'device', 'demo'].includes(mode)) throw new RangeError('Invalid workspace mode');
    data = bytes(data); baseline = bytes(baseline);
    if (data.length !== PROFILE.capacity || baseline.length !== PROFILE.capacity)
      throw new RangeError('Workspace storage must be exactly 4 MiB; use explicit coverage for partial reads');
    this.id = globalThis.crypto.randomUUID();
    this.name = String(name).slice(0, 200); this.mode = mode;
    this.data = data.slice(); this.baseline = baseline.slice();
    this.coverage = normalizeCoverage(coverage);
    this.sessionId = mode === 'device' ? sessionId : null;
    this.provenance = { ...provenance }; this.importedDirty = Boolean(importedDirty);
    this.revision = 0; this.journal = []; this.uncertain = false;
    // Unread storage is only an allocation convenience, never an observed FF.
    let cursor = 0;
    for (const r of this.coverage) {
      if (!equalBytes(this.data.subarray(cursor, r.address), this.baseline.subarray(cursor, r.address)))
        throw new RangeError('Changes outside memory coverage are not allowed');
      cursor = r.address + r.length;
    }
    if (!equalBytes(this.data.subarray(cursor), this.baseline.subarray(cursor)))
      throw new RangeError('Changes outside memory coverage are not allowed');
  }
  get loadedBytes() { return this.coverage.reduce((s, r) => s + r.length, 0); }
  get complete() { return covers(this.coverage, 0, PROFILE.capacity); }
  has(address, length) { return covers(this.coverage, address, length); }
  require(address, length) {
    if (!this.has(address, length)) throw new RangeError(`未读取地址 0x${address.toString(16)} 的 ${length} 字节；不能用空白数据替代。`);
  }
  apply(next) {
    next = bytes(next);
    if (next.length !== this.data.length) throw new RangeError('An edit must preserve memory size');
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== this.data[i] && !this.has(i, 1)) throw new RangeError('Edit touches unread storage');
    }
    this.data = next.slice(); this.revision++;
  }
  differences() {
    const changes = [];
    for (const range of this.coverage) {
      let start = null;
      const end = range.address + range.length;
      for (let i = range.address; i <= end; i++) {
        const dirty = i < end && this.data[i] !== this.baseline[i];
        if (dirty && start === null) start = i;
        if (!dirty && start !== null) {
          const before = this.baseline.slice(start, i), after = this.data.slice(start, i);
          changes.push({ address: start, length: i - start, before, after,
            region: regionAt(start)?.label ?? '原始存储', before_hex: hex(before), after_hex: hex(after) });
          start = null;
        }
      }
    }
    return changes;
  }
  dirtyBytes() { return this.differences().reduce((s, r) => s + r.length, 0); }
  rangeDirty(address, length) {
    return this.has(address, length) && !equalBytes(this.data.subarray(address, address + length), this.baseline.subarray(address, address + length));
  }
  discard() {
    if (this.uncertain) throw new Error('一次写入结果不确定；请重新读取设备再建立基线。');
    this.data = this.baseline.slice(); this.revision++;
  }
  planWrites() {
    if (this.uncertain) throw new Error('上一轮写入状态不确定，请先重新读取设备。');
    const result = [];
    for (const change of this.differences()) {
      for (let n = 0; n < change.length;) {
        const address = change.address + n;
        const region = regionAt(address);
        const count = Math.min(128, change.length - n, 4096 - address % 4096,
          region ? region.address + region.length - address : 128);
        if (!isWritableRange(address, count))
          throw new Error(`地址 0x${address.toString(16)} 位于尚未验证的写入区；只可导出留存。`);
        this.require(address, count);
        result.push({ address, length: count, before: change.before.slice(n, n + count), after: change.after.slice(n, n + count) });
        n += count;
      }
    }
    return { workspaceId: this.id, revision: this.revision, blocks: result,
      bytes: result.reduce((s, r) => s + r.length, 0) };
  }
}

/** Preflight ALL bytes before the first write, then serialize writes+verification.
 * Only a workspace read in this live session can be written. File metadata can
 * never confer trust. Backups are handed to the caller before a write occurs. */
export async function executeWritePlan(workspace, session, sessionId, plan, { signal, onProgress, onBackup } = {}) {
  if (!(workspace instanceof MemoryWorkspace) || workspace.mode !== 'device' || !sessionId || workspace.sessionId !== sessionId)
    throw new Error('请在本次连接中先读取设备；导入文件和演示数据不会取得设备写入权限。');
  if (workspace.uncertain || plan.workspaceId !== workspace.id || plan.revision !== workspace.revision)
    throw new Error('工作区已变化，请重新预览写入差异。');
  if (!session.identity?.writeEnabled) throw new Error('当前设备身份或认证状态不允许写入。');
  const fresh = workspace.planWrites();
  if (fresh.blocks.length !== plan.blocks.length || fresh.blocks.some((b, i) =>
    b.address !== plan.blocks[i].address || !equalBytes(b.before, plan.blocks[i].before) || !equalBytes(b.after, plan.blocks[i].after)))
    throw new Error('写入计划已过期。');
  let checked = 0;
  for (const block of plan.blocks) {
    signal?.throwIfAborted();
    const current = await session.readMemory(block.address, block.length, { signal });
    if (!equalBytes(current, block.before)) throw new Error(`设备数据已变化（0x${block.address.toString(16)}），未开始写入；请重新读取。`);
    checked += block.length;
    onProgress?.({ phase: 'preflight', completed: checked, total: plan.bytes });
  }
  await onBackup?.({ kind: 'configuration-before-write', plan: plan.blocks.map(b => ({ address: b.address, data: b.before.slice() })) });
  let written = 0;
  for (const block of plan.blocks) {
    signal?.throwIfAborted();
    const entry = { address: block.address, length: block.length, status: 'pending', time: new Date().toISOString() };
    workspace.journal.push(entry);
    try {
      const result = await session.writeMemory(block.address, block.after, { signal, onBackup });
      if (!result.verified) throw new Error('设备写入未通过回读校验。');
      workspace.baseline.set(block.after, block.address); entry.status = 'verified';
      written += block.length;
      onProgress?.({ phase: 'write', completed: written, total: plan.bytes });
    } catch (error) {
      entry.status = 'uncertain'; entry.error = String(error.message);
      workspace.uncertain = true; workspace.revision++;
      throw error;
    }
  }
  workspace.revision++;
  return { verified: true, writtenBytes: written, blocks: plan.blocks.length };
}
