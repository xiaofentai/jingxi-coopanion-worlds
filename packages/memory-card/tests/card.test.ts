import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCard, parseRules, splitBlocks, type CardInput } from '../src/card.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-card-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

function input(dir: string, rules: string, extra: Partial<CardInput> = {}): CardInput {
  return {
    folder: dir,
    rules,
    totalChars: 10_000,
    listOthers: false,
    listMax: 10,
    exclude: ['.git'],
    stamp: '11-07 15:20',
    language: 'zh',
    ...extra,
  };
}

describe('rules', () => {
  it('parses one line per file and reports the lines it cannot read', () => {
    const { rules, errors } = parseRules('# 注释\nA.md|whole||100; B.md|newest|2; C.md|whole||');
    expect(rules).toEqual([
      { path: 'A.md', mode: 'whole', arg: '', maxChars: 100 },
      { path: 'C.md', mode: 'whole', arg: '', maxChars: 0 },
    ]);
    expect(errors).toEqual(['B.md|newest|2']);
  });

  it('rejects a path that leaves the folder', () => {
    const dir = folder({ 'A.md': 'inside\n' });
    const result = buildCard(input(dir, '../outside.md|whole||200'));
    expect(result.card).toContain('../outside.md');
    expect(result.card).toContain('规则写错了');
  });
});

describe('blocks', () => {
  it('keeps the preamble and the headings as block titles', () => {
    const { pre, blocks } = splitBlocks('# 日志\n\n说明\n\n## 11-05\n- 甲\n\n## 待办\n- 乙\n');
    expect(pre).toContain('# 日志');
    expect(blocks.map((b) => b.title)).toEqual(['11-05', '待办']);
    expect(blocks[0]!.key).toBeGreaterThan(blocks[1]!.key);
  });
});

describe('whole and marker', () => {
  it('loads a file under a heading that names it and when it changed', () => {
    const dir = folder({ 'MEMORY.md': '# MEMORY\n\n- 名字：示例\n' });
    const result = buildCard(input(dir, 'MEMORY.md|whole||2000'));
    expect(result.card).toMatch(/^### MEMORY\.md（\d{2}-\d{2} \d{2}:\d{2}）$/m);
    expect(result.card).toContain('- 名字：示例');
    expect(result.meta).toMatch(/^读取 1 份 \/ \d+ 字 \/ 11-07 15:20$/);
  });

  it('leaves a whole file unlimited when its limit is empty', () => {
    const dir = folder({ 'MEMORY.md': `# MEMORY\n\n${'字'.repeat(3000)}\n` });
    const result = buildCard(input(dir, 'MEMORY.md|whole||'));
    expect(result.card).not.toContain('已截断');
    expect(result.loaded[0]!.kept).toBeGreaterThan(3000);
  });

  it('says how much was left out when the file is over its limit', () => {
    const dir = folder({ 'LONG.md': `# LONG\n\n${'字'.repeat(100)}\n` });
    const result = buildCard(input(dir, 'LONG.md|whole||40'));
    expect(result.card).toContain('（已截断：还有');
    expect(result.card).toContain('read_file 查看 LONG.md');
  });

  it('stops a marker file before the heading it names', () => {
    const dir = folder({ 'MEMORY.md': '# MEMORY\n\n## 说话\n- 短\n\n## 按需\n- 路径\n' });
    const result = buildCard(input(dir, 'MEMORY.md|marker|## 按需|2000'));
    expect(result.card).toContain('- 短');
    expect(result.card).not.toContain('- 路径');
  });

  it('falls back to the whole file when the heading is missing, and says so', () => {
    const dir = folder({ 'MEMORY.md': '# MEMORY\n\n- 路径\n' });
    const result = buildCard(input(dir, 'MEMORY.md|marker|## 按需|2000'));
    expect(result.card).toContain('- 路径');
    expect(result.card).toContain('没找到「## 按需」，整份载入');
  });
});

describe('dated blocks', () => {
  const dated = '# 日志\n\n## 11-03\n- 三天前\n\n## 11-06\n- 昨天\n\n## 11-07\n- 今天\n';

  it('takes the newest blocks, in the order the file has them', () => {
    const dir = folder({ '日志.md': dated });
    const result = buildCard(input(dir, '日志.md|newest|2|2000'));
    expect(result.card).not.toContain('三天前');
    expect(result.card.indexOf('昨天')).toBeLessThan(result.card.indexOf('今天'));
    expect(result.loaded[0]!.blocks).toBe(2);
  });

  it('orders by the heading date, not by where the block sits', () => {
    const dir = folder({ '日志.md': '# 日志\n\n## 11-03\n- 甲\n\n## 11-02\n- 乙\n\n## 11-05\n- 丙\n' });
    const result = buildCard(input(dir, '日志.md|newest|1|2000'));
    expect(result.card).toContain('丙');
    expect(result.card).not.toContain('乙');
  });

  it('drops the oldest block before it cuts text', () => {
    const dir = folder({ 'X.md': `# X\n\n## 11-05\n${'旧'.repeat(200)}\n\n## 11-06\n${'新'.repeat(200)}\n` });
    const result = buildCard(input(dir, 'X.md|newest|2|300'));
    expect(result.card).toContain('新');
    expect(result.card).not.toContain('旧');
  });

  it('keeps the named block as well as the newest ones', () => {
    const dir = folder({ '日志.md': '# 日志\n\n## 11-02\n- 旧\n\n## 11-05\n- 新\n\n## 待办\n- 待办\n' });
    const result = buildCard(input(dir, '日志.md|newest+pin|1,待办|2000'));
    expect(result.card).toContain('新');
    expect(result.card).toContain('待办');
    expect(result.card).not.toContain('旧');
  });
});

describe('the rest of the card', () => {
  it('lists files it did not load, with their first line', () => {
    const dir = folder({
      'A.md': '# 甲\n\n正文\n',
      'sub/B.md': '# 乙\n',
      'archive/C.md': '# 丙\n',
      'notes.txt': 'no\n',
    });
    const result = buildCard(input(dir, 'A.md|whole||2000', { listOthers: true, exclude: ['archive'] }));
    expect(result.index).toContain('sub/B.md：乙');
    expect(result.index).not.toContain('A.md');
    expect(result.index).not.toContain('C.md');
    expect(result.index).not.toContain('notes.txt');
  });

  it('drops whole files from the end when the total is over its limit', () => {
    const dir = folder({ 'A.md': 'a'.repeat(100), 'B.md': 'b'.repeat(100) });
    const result = buildCard(input(dir, 'A.md|whole||2000; B.md|whole||2000', { totalChars: 150 }));
    expect(result.card).toContain('a');
    expect(result.card).not.toContain('b');
    expect(result.card).toContain('还有 1 份因总上限没有载入');
    expect(result.loaded.map((file) => file.path)).toEqual(['A.md']);
  });

  it('reports a file that is not there instead of going blank', () => {
    const dir = folder({ 'A.md': 'x\n' });
    const result = buildCard(input(dir, 'MISSING.md|whole||2000'));
    expect(result.card).toContain('MISSING.md 不存在，跳过');
    expect(result.missing).toEqual(['MISSING.md']);
  });

  it('says the folder cannot be read instead of throwing', () => {
    const result = buildCard(input(join(tmpdir(), 'memory-card-does-not-exist'), 'A.md|whole||2000'));
    expect(result.card).toContain('目录读不到');
    expect(result.loaded).toEqual([]);
  });
});
