/**
 * 测试夹具：给**每个测试进程**分配一个独占的临时 `DATA_DIR`。
 *
 * 为什么需要（task-18 B）：
 * `node --test` 并行跑多个测试文件（每个文件一个进程），而这些进程默认共享同一个
 * `DATA_DIR`（没有显式设置时是仓库里的 `./data`）→ 多个进程同时打开同一个 SQLite，
 * 偶发 `database is locked`（`ERR_SQLITE_ERROR` errcode 5，`server/db.ts:14`）。
 * 让每个测试文件独占一个临时目录即可根治；已实测并行 3 次 `npm test` 稳定 0 失败。
 *
 * 用法（必须让本模块**先于**任何会触碰 `server/db.ts` 的模块被求值）：
 * ```ts
 * import './testDataDir.js'        // ← 放在所有 import 的第一行（副作用：设置 DATA_DIR）
 * import { db } from './db.js'     // ← 之后 config.ts / db.ts 才会读到新的 DATA_DIR
 * ```
 * ESM 按 import 声明顺序求值，因此「第一行」这个约束是充分的。
 *
 * 例外与开关：
 * - 自行 `mkdtempSync()` + 设置 `DATA_DIR` 的测试（如 `keyPoolReconcile.test.ts`）**不要**引入本模块；
 * - `CROSERY_TEST_KEEP_DATA_DIR=1` 可保留临时目录（默认退出时删除，便于排查失败现场）；
 * - `CROSERY_TEST_DATA_DIR_SHARED=1` 时不覆盖 `DATA_DIR`（仅在需要复现旧行为时使用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const shared = process.env.CROSERY_TEST_DATA_DIR_SHARED === '1'
const keep = process.env.CROSERY_TEST_KEEP_DATA_DIR === '1'

const dir = shared && process.env.DATA_DIR
  ? process.env.DATA_DIR
  : fs.mkdtempSync(path.join(os.tmpdir(), `crosery-test-${process.pid}-`))

if (!shared) process.env.DATA_DIR = dir
// 共享模型目录默认在 ~/.agents/crosery/catalog.json：不隔离时测试结果取决于开发机上那份真实目录
// （例如 gpt-image-2.5 被判成 chat）。需要目录的测试自己设置 CROSERY_SHARED_CATALOG。
process.env.CROSERY_SHARED_CATALOG ||= path.join(dir, 'no-shared-catalog.json')

if (!keep && !shared) {
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 退出清理是尽力而为：残留一个临时目录不应让测试失败
    }
  })
}

/** 当前测试进程独占的数据目录（模块求值时即创建，并写入 `process.env.DATA_DIR`）。 */
export const testDataDir = dir
