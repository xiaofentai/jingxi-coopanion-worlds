/**
 * 「设置」面板：判定细节与雷达调参，各一张可折叠的卡。
 *
 * 手写的 ESM，不经打包——控制台用浏览器原生 `import()` 加载这个文件，只要求默认导出
 * `{ panels: { <id>: { mount(ctx) } } }`。所以这里不能写 TS、也不能 import 本地模块。
 *
 * 长相完全复用控制台自己的：卡是 `ui.foldSheet`，行是设置页那套 `companion-row / configline /
 * tfield / tunit`，控件是 `ui.input` / `ui.checkbox`。字段、标签、单位、范围都由 World 算好
 * （读 `status`），这里只负责画和把改动存回去。
 */
const SAVE_DEBOUNCE_MS = 600;
const POLL_MS = 3000;

/** `tone` → `ui.pill` 认的那三种。 */
const TONE = { ok: 'on', off: 'off' };

const settingsPanel = {
  mount(ctx) {
    const ui = ctx.ui;
    const root = ctx.root;

    const message = ui.msgline('');
    // 卡与卡之间的间距交给容器：面板的 root 不管这个，`.measure > .sheet + .sheet` 那套也用不上。
    const cards = ui.h('div');
    cards.style.cssText = 'display:grid;gap:16px';
    root.append(cards, message);

    /** field key → 读控件当前值；渲染时重建。 */
    let readers = new Map();
    /** field key → 把新值写回控件；渲染时重建。 */
    let writers = new Map();
    /** 上一次渲染的字段集合；变了才重建，否则只同步取值，免得打字时丢焦点。 */
    let signature = '';
    let timer = null;

    const signOf = (payload) => payload.sections
      .map((section) => `${section.id}:${section.fields.map((field) => field.key).join(',')}`)
      .join('|');

    const collect = () => {
      const out = {};
      for (const [key, read] of readers) {
        const value = read();
        if (value !== undefined) out[key] = value;
      }
      return out;
    };

    const save = async () => {
      let next;
      try {
        next = await ctx.invoke('save', [collect()]);
      } catch (error) {
        message.textContent = String((error && error.message) || error);
        return;
      }
      message.textContent = (next.labels && next.labels.saved) || '';
      apply(next);
    };

    const queueSave = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void save();
      }, SAVE_DEBOUNCE_MS);
    };

    /** 设置页那样的两列行：左边标签，右边控件（可带单位），下面一行说明。 */
    const fieldRow = (field) => {
      const row = ui.h('div', 'companion-row configrow');
      const label = ui.h('div', 'companion-label', field.label);
      const control = ui.h('div', 'companion-control');
      const line = ui.h('div', 'configline');
      control.append(line);

      if (field.kind === 'bool') {
        const box = ui.checkbox('', { checked: !!field.value, onChange: () => queueSave() });
        box.input.setAttribute('aria-label', field.label);
        line.classList.add('companion-switchbox');
        line.append(box.el);
        readers.set(field.key, () => box.checked);
        writers.set(field.key, (value) => box.setChecked(!!value));
      } else {
        const wrap = ui.h('div', 'tfield');
        const input = ui.input({
          type: field.kind === 'int' ? 'number' : 'text',
          value: field.value === undefined || field.value === null ? '' : String(field.value),
          onInput: () => { message.textContent = ''; },
          onChange: () => queueSave(),
        });
        if (field.kind === 'int') {
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
        }
        wrap.append(input);
        line.append(wrap);
        if (field.suffix) line.append(ui.h('span', 'tunit', field.suffix));
        readers.set(field.key, () => {
          if (field.kind !== 'int') return input.value;
          const n = Number(input.value);
          return input.value !== '' && Number.isFinite(n) ? n : undefined;
        });
        writers.set(field.key, (value) => {
          const text = value === undefined || value === null ? '' : String(value);
          if (input.value !== text) input.value = text;
        });
      }

      if (field.hint) control.append(ui.h('p', 'home-note', field.hint));
      row.append(label, control);
      return row;
    };

    /** 雷达那张卡顶上的一行状态：一颗药丸 + 端口与读数。 */
    const statusRow = (status, label) => {
      const row = ui.h('div', 'companion-row configrow');
      const control = ui.h('div', 'companion-control');
      const line = ui.h('div', 'configline');
      if (status.enabled) {
        line.append(ui.pill(status.text || '—', TONE[status.tone] || 'plain'));
        if (status.hint) line.append(ui.h('span', 'tdesc', status.hint));
      } else {
        line.append(ui.h('span', 'tdesc', status.text || '—'));
      }
      control.append(line);
      row.append(ui.h('div', 'companion-label', label), control);
      return row;
    };

    const render = (payload) => {
      readers = new Map();
      writers = new Map();
      cards.replaceChildren();
      for (const section of payload.sections) {
        const card = ui.foldSheet(section.id, {
          title: section.title,
          ...(section.description ? { desc: section.description } : {}),
          defaultOpen: true,
        });
        cards.append(card.el);
        if (section.status) card.body.append(statusRow(section.status, payload.labels.status));
        for (const field of section.fields) card.body.append(fieldRow(field));
        if (!section.fields.length && section.note) card.body.append(ui.h('p', 'home-note', section.note));
      }
      signature = signOf(payload);
    };

    /** 只把值写回现有控件：不重建，焦点与滚动都在原处。 */
    const sync = (payload) => {
      for (const section of payload.sections) {
        for (const field of section.fields) {
          const write = writers.get(field.key);
          if (write) write(field.value);
        }
      }
    };

    const apply = (payload) => {
      if (!payload || !Array.isArray(payload.sections)) return;
      if (signOf(payload) !== signature) render(payload);
      else sync(payload);
    };

    const refresh = async () => {
      let payload;
      try {
        payload = await ctx.invoke('status');
      } catch (error) {
        console.error('[are-you-there] could not read the settings', error);
        return;
      }
      apply(payload);
    };

    void refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { settings: settingsPanel } };
