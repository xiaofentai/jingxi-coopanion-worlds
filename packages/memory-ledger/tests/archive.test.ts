import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archivedDates, ensureArchiveFile, landingSpot } from '../src/archive.ts';

function withTmp(run: (root: string) => void): () => void {
  return () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-archive-'));
    try {
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('默认落在 archive/大事记-归档.md，启用时建出来', withTmp((root) => {
  const full = ensureArchiveFile(root, '');
  assert.equal(full, join(root, 'archive', '大事记-归档.md'));
  assert.ok(existsSync(full!));
  const text = readFileSync(full!, 'utf8');
  assert.match(text, /^# 归档\n/);
  assert.match(text, /不进前缀/);
}));

test('归档路径可以换成别的：指向哪就建到哪', withTmp((root) => {
  const full = ensureArchiveFile(root, 'partner/归档.md');
  assert.equal(full, join(root, 'partner', '归档.md'));
  assert.ok(existsSync(full!));
  assert.ok(!existsSync(join(root, 'archive', '大事记-归档.md')));
}));

test('归档已经在的时候不覆盖它', withTmp((root) => {
  const folder = join(root, 'archive');
  mkdirSync(folder, { recursive: true });
  const archive = join(folder, '大事记-归档.md');
  writeFileSync(archive, '# 归档\n\n## 2026-10\n- 旧的一条。\n', 'utf8');
  ensureArchiveFile(root, '');
  assert.match(readFileSync(archive, 'utf8'), /旧的一条。/);
}));

test('越界路径一律拒绝：绝对路径、带 ..、另一个盘', withTmp((root) => {
  assert.equal(landingSpot(root, 'C:/windows/x.md'), null);
  assert.equal(landingSpot(root, '../外面.md'), null);
  assert.equal(ensureArchiveFile(root, '../外面.md'), null);
}));

test('目录不可写时不抛异常，只是返回 null', withTmp((root) => {
  // 把 archive 做成一个文件，mkdir 必然失败
  writeFileSync(join(root, 'archive'), 'not a directory', 'utf8');
  assert.equal(ensureArchiveFile(root, ''), null);
}));

test('archivedDates 只认块标题里的日期，正文里的不算', withTmp((root) => {
  mkdirSync(join(root, 'archive'), { recursive: true });
  writeFileSync(
    join(root, 'archive', '流水.md'),
    '# 归档\n\n## 11-05\n- 那天提到 11-09 的事，但标题是 11-05\n\n## 2026-10-14\n- 月块和日块混着\n',
    'utf8',
  );
  const dates = archivedDates(root, 'archive/流水.md', 2026).sort();
  assert.deepEqual(dates, ['2026-10-14', '2026-11-05']);
}));

test('归档目录不存在时返回空数组，不抛异常', withTmp((root) => {
  assert.deepEqual(archivedDates(root, 'archive/流水.md', 2026), []);
}));
