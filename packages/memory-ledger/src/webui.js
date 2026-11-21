/**
 * 「设置」面板：目录、文件名、索引天数、触发开关。
 *
 * 手写 ESM，不经打包；控制台用浏览器原生 import() 加载。字段、标签、单位都由
 * World 算好（status），这里只负责画和把改动存回去。配置页只剩启用开关。
 */
const SAVE_DEBOUNCE_MS = 600;
const POLL_MS = 3000;

const settingsPanel = {
  mount(ctx) {
    const ui = ctx.ui;
    const root = ctx.root;
    const message = ui.msgline('');
    const cards = ui.h('div', 'ml-settings');
    cards.style.cssText = 'display:grid;gap:16px';
    root.append(cards, message);

    let readers = new Map();
    let writers = new Map();
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
          if (input.value === '') return undefined;
          const value = Number(input.value);
          return Number.isFinite(value) ? value : undefined;
        });
        writers.set(field.key, (value) => {
          // 正在敲的框不要回写：轮询每 3 秒一次，回写会吞掉光标和没保存的字。
          // 失焦时 change 会存盘，之后再对齐就不打架（见设置页交接 4.7）。
          if (input.ownerDocument && input.ownerDocument.activeElement === input) return;
          const text = value === undefined || value === null ? '' : String(value);
          if (input.value !== text) input.value = text;
        });
      }

      if (field.hint) control.append(ui.h('p', 'home-note', field.hint));
      row.append(label, control);
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
        for (const field of section.fields) card.body.append(fieldRow(field));
      }
      signature = signOf(payload);
    };

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
        console.error('[memory-ledger] could not read settings', error);
        return;
      }
      apply(payload);
    };

    void refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { settings: settingsPanel } };
