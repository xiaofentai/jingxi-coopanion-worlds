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

function sandbox(run: (box: Sandbox) => void, todayFile = '超近期.md', rules = RULES, today = '2026-11-10'): void {
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
    today: () => today,
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

test('ml_rename 只改标题那一行，块里的条目一条不动', () => {
  sandbox((box) => {
    const receipt = box.run('ml_rename', { block: '还挂着', new: '## 手头的事' });
    assert.match(receipt, /已改标题：## 还挂着 {2}→ {2}## 手头的事/);
    assert.match(receipt, /1 条一条没动/);
    const after = box.read('超近期.md');
    assert.match(after, /## 手头的事\n- 备份拷到不联网盘。/);
    assert.ok(!after.includes('## 还挂着'));
  });
});

test('ml_rename 不许和别的块重名', () => {
  sandbox((box) => {
    const receipt = box.run('ml_rename', { block: '还挂着', new: '11-09（周一）' });
    assert.match(receipt, /已经有块叫「11-09（周一）」/);
    assert.match(box.read('超近期.md'), /## 还挂着/);
  });
});

test('ml_rename 不许改日块的日期，只许换括号里的星期', () => {
  sandbox((box) => {
    assert.match(box.run('ml_rename', { block: '11-10', new: '11-11（周三）' }), /日块的标题要以 11-10 开头/);
    assert.match(box.run('ml_rename', { block: '11-10', new: '11-10（星期一）' }), /已改标题/);
    assert.match(box.read('超近期.md'), /## 11-10（星期一）/);
  });
});

test('ml_rename 不许改月块的标题（目录和覆盖都靠它）', () => {
  sandbox((box) => {
    const receipt = box.run('ml_rename', { file: '大事记.md', block: '2026-10', new: '2026-12' });
    assert.match(receipt, /月块的标题只能是 2026-10/);
    assert.match(box.read('大事记.md'), /## 2026-10/);
  });
});

test('ml_rename 找不到块时不动盘', () => {
  sandbox((box) => {
    const receipt = box.run('ml_rename', { block: '压根没有这块', new: '随便什么' });
    assert.match(receipt, /没找到「压根没有这块」/);
    assert.match(box.read('超近期.md'), /## 还挂着/);
  });
});

test('ml_check 报出首行不合格的块（抄流水第一条的那种）', () => {
  // 只有 catalog 会把首行搬进目录，所以规则要写成 catalog
  sandbox((box) => {
    const receipt = box.run('ml_check', {});
    // 11-09 是「18:00 …」、11-10 是「13:00 …」；「还挂着」是合格的
    assert.match(receipt, /该整理 2 处/);
    assert.match(receipt, /11-09」：首行以 18:00 开头/);
    assert.match(receipt, /11-10」：首行以 13:00 开头/);
    assert.ok(!receipt.includes('还挂着」：首行'));
  }, '超近期.md', '超近期.md|catalog|7|');
});

test('ml_check 认裸行首行：不带 `- ` 也算这一块的第一句', () => {
  sandbox((box) => {
    // 把 11-10 的首条改成裸行的一句话——和目录取的是同一行
    box.run('ml_edit', { block: '11-10', old: '- 13:00 生态箱同步报错。', new: '两场十二人局，写了 15k。' });
    const receipt = box.run('ml_check', {});
    // 内容判据过了：不再说“首行以 13:00 开头”
    assert.ok(!receipt.includes('首行以 13:00 开头'));
    // 但格式判据会报裸行（见下一个用例）
    assert.match(receipt, /该整理 [12] 处/);
  }, '超近期.md', '超近期.md|catalog|7|');
});

test('ml_check 报出裸行，并说清加个 `- ` 就成条目', () => {
  sandbox((box) => {
    box.run('ml_edit', { block: '11-10', old: '- 13:00 生态箱同步报错。', new: '两场十二人局，写了 15k。' });
    const receipt = box.run('ml_check', {});
    assert.match(receipt, /11-10」：首行是裸行（不成条目，ml_delete 删不掉）/);
    assert.match(receipt, /加个 `- ` 前缀就成条目/);
  }, '超近期.md', '超近期.md|catalog|7|');
});

test('ml_check 加了 `- ` 之后就不再报裸行', () => {
  sandbox((box) => {
    box.run('ml_edit', { block: '11-10', old: '- 13:00 生态箱同步报错。', new: '两场十二人局，写了 15k。' });
    box.run('ml_edit', { block: '11-10', old: '两场十二人局，写了 15k。', new: '- 两场十二人局，写了 15k。' });
    const receipt = box.run('ml_check', {});
    assert.ok(!receipt.includes('裸行'));
  }, '超近期.md', '超近期.md|catalog|7|');
});

test('ml_check 报出窗口外的天', () => {
  sandbox((box) => {
    const receipt = box.run('ml_check', {});
    assert.match(receipt, /11-09」：已第 2 天（窗口 1 天）：该搬到下一份/);
    assert.ok(!receipt.includes('11-10」：已第'));
  }, '超近期.md', '超近期.md|catalog|1|');
});

test('ml_check 报出条目超额的那一份', () => {
  sandbox((box) => {
    const receipt = box.run('ml_check', {});
    // 大事记 有 10-14 / 10-20 / 11-01 共 3 条，上限 2
    assert.match(receipt, /大事记\.md「（整份）」：已到 3\/2 条（150%）/);
  }, '超近期.md', '超近期.md|whole||7000; 大事记.md|catalog||2');
});

test('ml_check 没有要整理的就直说没有', () => {
  sandbox((box) => {
    assert.match(box.run('ml_check', {}), /该整理：没有/);
  }, '超近期.md', '');
});

/** 大事记 的上限写在它自己的规则里：`full` 的第 4 段是条目数。 */
const RULES_CAP = `${RULES}; 大事记.md|full||5`;

test('ml_add：到 80% 报到但照写，写满上限后拒绝', () => {
  sandbox((box) => {
    // 现有 3 条，上限 5 → 写第四条到 80%，照写并报账
    const at80 = box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '第四条。' });
    assert.match(at80, /已记进 大事记\.md/);
    assert.match(at80, /现在 4\/5 条，到 80%/);
    assert.match(at80, /alarm_set/);

    // 再写一条正好写满 5 条（100%），仍然允许
    const full = box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '第五条。' });
    assert.match(full, /现在 5\/5 条，到 100%/);

    // 满了以后拒写，并把两条路与现有条目给回去
    const receipt = box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '第六条。' });
    assert.match(receipt, /已经 5 条，到 5 的上限了/);
    assert.match(receipt, /ml_forget\(file="大事记\.md"/);
    assert.match(receipt, /archive\/大事记-归档\.md/);
    assert.ok(!box.read('大事记.md').includes('第六条'));
  }, '超近期.md', RULES_CAP);
});

test('上限只管写了条目规则的那一份；没写规则的照写不误', () => {
  sandbox((box) => {
    // 超近期 没有 catalog / full 规则 → 完全不受条目上限约束
    for (let i = 0; i < 5; i += 1) {
      assert.match(box.run('ml_add', { text: `第 ${i} 条。` }), /已记进 超近期\.md/);
    }
    // 大事记满了也不影响往归档写，且归档文件是新建的
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: 'a' });
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: 'b' });
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: 'c' });
    const receipt = box.run('ml_add', { file: 'archive/大事记-归档.md', block: '2026-11', text: '这条只进归档。' });
    assert.match(receipt, /已记进 archive\/大事记-归档\.md/);
    assert.match(receipt, /原来没有，这次建起来了/);
    assert.match(box.read('archive/大事记-归档.md'), /这条只进归档。/);
  }, '超近期.md', RULES_CAP);
});

test('往月块补写旧日子：按日期插，不跑到块尾', () => {
  sandbox((box) => {
    // 2026-10 现有 **10-14**、**10-20**，补一条 10-16
    box.run('ml_add', { file: '大事记.md', block: '2026-10', text: '**10-16**：能动性装上。' });
    const after = box.read('大事记.md');
    const at14 = after.indexOf('**10-14**');
    const at16 = after.indexOf('**10-16**');
    const at20 = after.indexOf('**10-20**');
    assert.ok(at14 < at16 && at16 < at20, `顺序应是 14 → 16 → 20，实际 ${at14} / ${at16} / ${at20}`);
  });
});

test('往月块写比所有条目都晚的日子，还是追加到末尾', () => {
  sandbox((box) => {
    box.run('ml_add', { file: '大事记.md', block: '2026-11', text: '**11-20**：后来的一天。' });
    const after = box.read('大事记.md');
    assert.ok(after.indexOf('**11-01**') < after.indexOf('**11-20**'));
  });
});

test('块首那句「这个月的一句话」不参与排序，永远在最前', () => {
  sandbox((box) => {
    box.run('ml_add', { file: '大事记.md', block: '2026-10', text: '10 月：换了个模型。', first: true });
    box.run('ml_add', { file: '大事记.md', block: '2026-10', text: '**10-12**：更早的一天。' });
    const after = box.read('大事记.md');
    const summary = after.indexOf('10 月：换了个模型。');
    const at12 = after.indexOf('**10-12**');
    const at14 = after.indexOf('**10-14**');
    assert.ok(summary < at12 && at12 < at14, `顺序应是 摘要 → 12 → 14，实际 ${summary} / ${at12} / ${at14}`);
  });
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

test('ml_move 可以搬进归档里的新文件（折叠第一次落盘就是新建）', () => {
  sandbox((box) => {
    const receipt = box.run('ml_move', { from: '近期.md', block: '11-07', to: 'archive/近期-流水.md' });
    assert.match(receipt, /已把「11-07」（\d+ 字）从 近期\.md/);
    assert.match(receipt, /搬到 archive\/近期-流水\.md/);
    assert.match(box.read('archive/近期-流水.md'), /## 11-07（周六）\n- 六人狼人杀，我赢了。/);
    assert.ok(!box.read('近期.md').includes('## 11-07'));
  });
});

test('ml_move 不许把归档里的东西搬出来——归档是单向的', () => {
  sandbox((box) => {
    box.run('ml_forget', { file: '近期.md', block: '11-07', old: '六人狼人杀' });
    const receipt = box.run('ml_move', { from: 'archive/大事记-归档.md', block: '2026-11', to: '近期.md' });
    assert.match(receipt, /归档里，不再搬出来/);
    assert.match(box.read('archive/大事记-归档.md'), /六人狼人杀/);
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
