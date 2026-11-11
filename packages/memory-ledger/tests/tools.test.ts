import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLedgerTools } from '../src/tools.ts';

const CJ = [
  '# 超近期（只留最近 2 天）',
  '',
  '## 11-09（周一）',
  '- 18:00 六人局，我 6 号平民。',
  '',
  '## 11-10（周二）',
  '- 13:00 生态箱同步报错。',
  '',
  '## 还挂着',
  '- 备份拷到不联网盘。',
  '',
].join('\n');

const JQ = ['# 近期', '', '## 11-07（周六）', '- 六人狼人杀，我赢了。', ''].join('\n');

const DSJ = [
  '# 大事记',
  '',
  '## 2026-10',
  '- **10-14**：第一次见面。',
  '- **10-20**：换了模型。',
  '',
  '## 2026-11',
  '- **11-01**：开始打狼人杀。',
  '',
].join('\n');

const RULES = '超近期.md|whole||7000|head; 近期.md|whole||4000|head';

interface Sandbox {
  folder: string;
  run: (name: string, args: Record<string, unknown>) => string;
  read: (name: string) => string;
}

function sandbox(run: (box: Sandbox) => void, todayFile = '超近期.md', rules = RULES): void {
  const root = mkdtempSync(join(tmpdir(), 'ledger-tools-'));
  const folder = join(root, 'workspace');
  const backups = join(root, 'backups');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '超近期.md'), CJ, 'utf8');
  writeFileSync(join(folder, '近期.md'), JQ, 'utf8');
  writeFileSync(join(folder, '大事记.md'), DSJ, 'utf8');
  const tools = createLedgerTools({
    folder: () => folder,
    rules: () => rules,
    backupDir: () => backups,
    today: () => '2026-11-10',
    todayFile: () => todayFile,
    archiveFile: () => '',
  });
  const box: Sandbox = {
    folder,
    run: (name, args) => String(tools.find((tool) => tool.name === name)?.handler(args as never) ?? ''),
    read: (name) => readFileSync(join(folder, name), 'utf8'),
  };
  try {
    run(box);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('ml_check 说出每份几块、日期到哪', () => {
  sandbox((box) => {
    const text = box.run('ml_check', {});
    assert.match(text, /超近期\.md：\d+ 字／2 天（11-09~11-10）／3 条；特殊块 还挂着/);
    assert.match(text, /近期\.md：.*1 天（11-07~11-07）/);
    // 11-08 在 11-07 和 11-09 之间缺失
    assert.match(text, /覆盖：缺 11-08/);
  });
});

test('ml_add 追加到今天，不动别的块', () => {
  sandbox((box) => {
    const receipt = box.run('ml_add', { text: '14:37 他问鼠妇会不会繁殖。' });
    assert.match(receipt, /已记进 超近期\.md/);
    const after = box.read('超近期.md');
    assert.match(after, /## 11-10（周二）\n- 13:00 生态箱同步报错。\n- 14:37 他问鼠妇会不会繁殖。/);
    assert.match(after, /## 11-09（周一）\n- 18:00 六人局/);
  });
});

test('ml_add 没有今天这一块时，按日期新建并带星期', () => {
  sandbox((box) => {
    box.run('ml_add', { text: '早上他 10:04 打招呼。', block: '11-11' });
    const after = box.read('超近期.md');
    assert.match(after, /## 11-11（周三）/);
    // 新块排在有日期的块里，不掉到「还挂着」后面
    assert.ok(after.indexOf('## 11-11') < after.indexOf('## 还挂着'));
  });
});

test('ml_add 把 again 写进这一条', () => {
  sandbox((box) => {
    box.run('ml_add', { text: '首夜又空刀。', block: '11-10', again: '11-05,11-09' });
    assert.match(box.read('超近期.md'), /首夜又空刀。（again: 11-05、11-09）/);
  });
});

test('ml_add 拒绝超长与写错的 again', () => {
  sandbox((box) => {
    assert.match(box.run('ml_add', { text: 'x'.repeat(601) }), /超过 600 的限度/);
    assert.match(box.run('ml_add', { text: 'y', again: '前天' }), /again 只能写/);
  });
});

test('ml_add first 插到块首，原来第一条往后挪', () => {
  sandbox((box) => {
    const receipt = box.run('ml_add', { text: '两场 12 人局，写了 15k。', block: '11-10', first: true });
    assert.match(receipt, /写在块首/);
    const after = box.read('超近期.md');
    assert.match(after, /## 11-10（周二）\n- 两场 12 人局，写了 15k。\n- 13:00 生态箱同步报错。/);
  });
});

test('ml_forget 从原文件移出，整条归档进月份块', () => {
  sandbox((box) => {
    const receipt = box.run('ml_forget', { file: '近期.md', block: '11-07', old: '六人狼人杀' });
    assert.match(receipt, /已从 近期\.md「11-07」移出 1 条/);
    assert.match(receipt, /归档进 archive\/大事记-归档\.md「2026-11」/);

    // 原文件里那一条没了，块还在（空块不删）
    const source = box.read('近期.md');
    assert.ok(!source.includes('六人狼人杀'));
    assert.match(source, /## 11-07（周六）/);

    // 归档文件按月份块接住，且含原文
    const archive = box.read('archive/大事记-归档.md');
    assert.match(archive, /## 2026-11\n- 六人狼人杀，我赢了。/);
  });
});

test('ml_forget 第二次归档接在同一月份块后面，不再新建块', () => {
  sandbox((box) => {
    box.run('ml_forget', { file: '近期.md', block: '11-07', old: '六人狼人杀' });
    box.run('ml_forget', { file: '超近期.md', block: '11-09', old: '六人局' });
    const archive = box.read('archive/大事记-归档.md');
    assert.equal((archive.match(/^## /gm) ?? []).length, 1);
    assert.match(archive, /## 2026-11\n- 六人狼人杀，我赢了。\n- 18:00 六人局，我 6 号平民。/);
  });
});

test('ml_forget 找不到那条就不动盘', () => {
  sandbox((box) => {
    const receipt = box.run('ml_forget', { file: '近期.md', block: '11-07', old: '没有这一条' });
    assert.match(receipt, /没有含「没有这一条」的条目/);
    assert.match(receipt, /它现在的条目/);
    assert.match(box.read('近期.md'), /六人狼人杀/);
  });
});

/** 大事记 的上限写在它自己的规则里：catalog 的第 4 段是条目数。 */
const RULES_CAP = `${RULES}; 大事记.md|catalog||2`;

test('ml_add 超过条目上限两倍时拒绝，并把两条路与现有条目给回去', () => {
  sandbox((box) => {
    // 现在 大事记 是 3 条，上限 2 → 没到两倍（4），照写，但回执报账
    const ok = box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '第三条。' });
    assert.match(ok, /已记进 大事记\.md/);
    assert.match(ok, /现在 4 条，超过上限 2/);
    assert.match(ok, /alarm_set/);

    // 4 条 = 上限的两倍 → 拒绝
    const receipt = box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '第五条。' });
    assert.match(receipt, /已经 4 条，超过 2 的两倍/);
    assert.match(receipt, /ml_forget\(file="大事记\.md"/);
    assert.match(receipt, /archive\/大事记-归档\.md/);
    assert.match(receipt, /现在有：2026-10（2 条）、2026-11（2 条）/);
    assert.ok(!box.read('大事记.md').includes('第五条'));
  }, '超近期.md', RULES_CAP);
});

test('上限只管写了 catalog 规则的那一份；没写规则的照写不误', () => {
  sandbox((box) => {
    // 超近期 没有 catalog 规则 → 完全不受条目上限约束
    for (let i = 0; i < 5; i += 1) {
      assert.match(box.run('ml_add', { text: `第 ${i} 条。` }), /已记进 超近期\.md/);
    }
    // 大记事满了也不影响往归档写，且归档文件是新建的
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: 'a' });
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: 'b' });
    const receipt = box.run('ml_add', { file: 'archive/大事记-归档.md', block: '2026-11', text: '这条只进归档。' });
    assert.match(receipt, /已记进 archive\/大事记-归档\.md/);
    assert.match(receipt, /原来没有，这次建起来了/);
    assert.match(box.read('archive/大事记-归档.md'), /这条只进归档。/);
  }, '超近期.md', RULES_CAP);
});

test('ml_move 整块搬走，源里一天不少', () => {
  sandbox((box) => {
    const receipt = box.run('ml_move', { from: '超近期.md', block: '11-09', to: '近期.md' });
    assert.match(receipt, /已把「11-09」/);
    const target = box.read('近期.md');
    assert.match(target, /## 11-09（周一）\n- 18:00 六人局/);
    assert.ok(target.indexOf('## 11-07') < target.indexOf('## 11-09'), '按日期排在后面');
    const source = box.read('超近期.md');
    assert.doesNotMatch(source, /## 11-09/);
    // 11-10 与 还挂着 都还在
    assert.match(source, /## 11-10（周二）/);
    assert.match(source, /## 还挂着/);
  });
});

test('ml_move 目标已有同一天时拒绝，两个文件都不动', () => {
  sandbox((box) => {
    writeFileSync(join(box.folder, '近期.md'), `${JQ}\n## 11-09（周一）\n- 已经在了。\n`, 'utf8');
    const before = box.read('超近期.md');
    const receipt = box.run('ml_move', { from: '超近期.md', block: '11-09', to: '近期.md' });
    assert.match(receipt, /已经有「2026-11-09」/);
    assert.equal(box.read('超近期.md'), before);
  });
});

test('ml_move 不认越界路径', () => {
  sandbox((box) => {
    assert.match(box.run('ml_move', { from: '../outside.md', block: '11-09', to: '近期.md' }), /读不到/);
  });
});

test('ml_edit 改还挂着里的一句（今天它用 edit_file 做的那件事）', () => {
  sandbox((box) => {
    const receipt = box.run('ml_edit', { block: '还挂着', old: '备份拷到不联网盘', new: '备份已经同步到群晖了' });
    assert.match(receipt, /已改 超近期\.md「还挂着」1 处/);
    const after = box.read('超近期.md');
    assert.match(after, /备份已经同步到群晖了/);
    assert.match(after, /## 11-10（周二）\n- 13:00 生态箱同步报错。/);
  });
});

test('ml_delete 删掉一条测试记录', () => {
  sandbox((box) => {
    box.run('ml_add', { text: '测试一条，稍后删' });
    assert.match(box.read('超近期.md'), /测试一条，稍后删/);
    const receipt = box.run('ml_delete', { block: '11-10', old: '测试一条' });
    assert.match(receipt, /删掉一条「测试一条，稍后删」/);
    assert.doesNotMatch(box.read('超近期.md'), /测试一条/);
    // 同块其余条目还在
    assert.match(box.read('超近期.md'), /13:00 生态箱同步报错/);
  });
});

test('ml_edit 撞到两处时拒绝，文件一个字不动', () => {
  sandbox((box) => {
    const doubled = CJ.replace(
      '## 11-10（周二）\n- 13:00 生态箱同步报错。',
      '## 11-10（周二）\n- 13:00 生态箱同步报错。\n- 13:00 生态箱同步报错。',
    );
    writeFileSync(join(box.folder, '超近期.md'), doubled, 'utf8');
    const before = box.read('超近期.md');
    const receipt = box.run('ml_edit', { block: '11-10', old: '生态箱同步报错', new: '活体箱同步报错' });
    assert.match(receipt, /出现 2 次/);
    assert.equal(box.read('超近期.md'), before);
  });
});

test('ml_delete 找不到那一条时拒绝', () => {
  sandbox((box) => {
    const before = box.read('超近期.md');
    assert.match(box.run('ml_delete', { block: '11-10', old: '根本没有这句' }), /没有含/);
    assert.equal(box.read('超近期.md'), before);
  });
});

test('ml_edit 改文件头：那天她写 block=「头」失败的地方', () => {
  sandbox((box) => {
    const receipt = box.run('ml_edit', { block: '文件头', old: '只留最近 2 天', new: '只留最近 3 天' });
    assert.match(receipt, /已改 超近期\.md「文件头」1 处/);
    const after = box.read('超近期.md');
    assert.match(after, /^# 超近期（只留最近 3 天）/);
    assert.match(after, /## 11-09（周一）\n- 18:00 六人局/);
  });
});

test('ml_edit 一条改成两条（new 带换行）不再被核对拦下', () => {
  sandbox((box) => {
    const receipt = box.run('ml_edit', {
      block: '11-09',
      old: '18:00 六人局，我 6 号平民。',
      new: '18:00 六人局，我 6 号平民。\n- 03:12 首夜空刀。',
    });
    assert.match(receipt, /已改 超近期\.md「11-09」1 处/);
    const after = box.read('超近期.md');
    assert.match(after, /18:00 六人局，我 6 号平民。\n- 03:12 首夜空刀。/);
    // 下一天与特殊块都没被动
    assert.match(after, /## 11-10（周二）\n- 13:00 生态箱同步报错。/);
    assert.match(after, /## 还挂着\n- 备份拷到不联网盘。/);
  });
});

test('ml_edit 的 old 抄错时，回执里能看见这一块现在是什么', () => {
  sandbox((box) => {
    const before = box.read('超近期.md');
    const receipt = box.run('ml_edit', { block: '11-10', old: '今晚只留了一张桌', new: 'x' });
    assert.match(receipt, /「11-10」里没有「今晚只留了一张桌」/);
    assert.match(receipt, /它现在的条目：\n- 13:00 生态箱同步报错。/);
    assert.equal(box.read('超近期.md'), before);
  });
});

test('ml_edit 的块名写错时，回执列出这份文件里的块', () => {
  sandbox((box) => {
    const receipt = box.run('ml_edit', { block: '头', old: 'x', new: 'y' });
    assert.match(receipt, /没找到「头」/);
    assert.match(receipt, /这份文件里有：2026-11-09、2026-11-10、还挂着/);
  });
});

test('不写 file 时落在配置的「今天那份」上，不是写死的 超近期.md', () => {
  sandbox((box) => {
    box.run('ml_add', { text: '14:37 他问鼠妇会不会繁殖。' });
    assert.match(box.read('近期.md'), /14:37 他问鼠妇会不会繁殖/);
    assert.doesNotMatch(box.read('超近期.md'), /鼠妇/);
  }, '近期.md');
});

test('「今天那份」留空时退回 超近期.md', () => {
  sandbox((box) => {
    box.run('ml_add', { text: '15:00 留空也要能写。' });
    assert.match(box.read('超近期.md'), /留空也要能写/);
  }, '');
});

test('写盘成功的回执会说这次改动没进版本历史', () => {
  sandbox((box) => {
    assert.match(box.run('ml_add', { text: '16:00 记一条。' }), /没进工作区版本历史/);
    assert.match(box.run('ml_edit', { block: '还挂着', old: '备份拷到不联网盘', new: '备份已经同步到群晖了' }), /没进工作区版本历史/);
    assert.match(box.run('ml_delete', { block: '11-10', old: '生态箱同步报错' }), /没进工作区版本历史/);
    assert.match(box.run('ml_move', { from: '近期.md', block: '11-07', to: '超近期.md' }), /没进工作区版本历史/);
  });
});
