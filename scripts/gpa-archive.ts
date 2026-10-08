/** @file-guide
 * 목적: GPA 역사 원장을 0600 JSON으로 export하거나 격리 _test DB의 빈 표에 restore한다. (script)
 * 책임/재사용: 기본 읽기 전용 export와 restore 확인·대상 가드를 소유하며 데이터 규칙은 src/lib/gpa-archive.ts를 재사용한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import 'reflect-metadata';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { exportGpaArchive, restoreGpaArchive, validateGpaArchive } from '../src/lib/gpa-archive';

dotenv.config({ path: '.env.local' });
dotenv.config();

const valueOf = (name: string): string | null => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

async function main(): Promise<void> {
  const exportPath = valueOf('export');
  const restorePath = valueOf('restore');
  const confirm = valueOf('confirm');
  const apply = process.argv.includes('--apply');
  if ((exportPath ? 1 : 0) + (restorePath ? 1 : 0) !== 1) throw new Error('--export=<json> 또는 --restore=<json> 하나가 필요합니다');

  await ds.initialize();
  const q = ds.createQueryRunner();
  await q.connect();
  try {
    const [{ db }] = await q.query(`SELECT current_database() AS db`) as Array<{ db: string }>;
    if (exportPath) {
      await q.startTransaction('REPEATABLE READ');
      await q.query('SET TRANSACTION READ ONLY');
      const snapshot = await exportGpaArchive(q);
      await q.commitTransaction();
      const target = path.resolve(exportPath);
      await fs.writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(target, 0o600);
      console.log(JSON.stringify({ mode: 'export', database: db, target, rowCounts: snapshot.rowCounts, dataSha256: snapshot.dataSha256 }, null, 2));
      return;
    }

    if (!apply) throw new Error('restore에는 --apply가 필요합니다');
    if (!/_test$/.test(db)) throw new Error(`restore는 이름이 _test로 끝나는 격리 DB만 허용합니다: ${db}`);
    if (confirm !== db) throw new Error(`--confirm 값이 현재 DB와 다릅니다: ${db}`);
    const snapshot = JSON.parse(await fs.readFile(path.resolve(restorePath!), 'utf8')) as unknown;
    validateGpaArchive(snapshot);
    await q.startTransaction();
    const restored = await restoreGpaArchive(q, snapshot);
    await q.commitTransaction();
    console.log(JSON.stringify({ mode: 'restore', database: db, rowCounts: restored.rowCounts, dataSha256: restored.dataSha256 }, null, 2));
  } catch (error) {
    if (q.isTransactionActive) await q.rollbackTransaction();
    throw error;
  } finally {
    await q.release();
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
