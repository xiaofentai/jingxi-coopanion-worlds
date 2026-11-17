/**
 * 「雷达状态」面板的前端：一颗点加一句话，每秒问一次 World。
 *
 * 手写的 ESM，不经打包——控制台用浏览器原生 `import()` 加载这个文件，只要求默认导出
 * `{ panels: { <id>: { mount(ctx) } } }`。所以这里不能写 TS、也不能 import 本地模块。
 *
 * 没打开雷达时整行隐藏：那时候没有状态可看，也不该留一颗误导的灰点。
 * 文案与语气都由 World 算好（`radar.status`），这里只负责上色，免得两边判断走偏。
 */
const COLORS = { ok: '#3ba55d', warn: '#d9a441', bad: '#d9534f', off: '#8a8a8a' };
const POLL_MS = 1000;

const radarPanel = {
  mount(ctx) {
    const doc = ctx.root.ownerDocument;

    const row = doc.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.padding = '6px 2px';
    row.style.fontSize = '14px';

    const dot = doc.createElement('span');
    dot.setAttribute('role', 'img');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '50%';
    dot.style.flex = '0 0 auto';
    dot.style.background = COLORS.off;

    const text = doc.createElement('span');
    const hint = doc.createElement('span');
    hint.style.color = 'var(--muted, #8a8a8a)';
    hint.style.fontSize = '12px';

    row.append(dot, text, hint);
    ctx.root.appendChild(row);

    const paint = async () => {
      let view;
      try {
        view = await ctx.invoke('status');
      } catch (error) {
        // 读不到就藏起来，别把上一次的读数当成现在
        row.style.display = 'none';
        console.error('[are-you-there] could not read the radar status', error);
        return;
      }
      if (!view || !view.enabled) {
        row.style.display = 'none';
        return;
      }
      row.style.display = 'flex';
      dot.style.background = COLORS[view.tone] || COLORS.off;
      text.textContent = view.text || '';
      hint.textContent = view.hint || '';
    };

    void paint();
    ctx.interval(() => void paint(), POLL_MS);
  },
};

export default { panels: { radar: radarPanel } };
