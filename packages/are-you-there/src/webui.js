/**
 * 「雷达」面板的前端：上面一行状态，下面是那几项调参，最后是保存。
 *
 * 手写的 ESM，不经打包——控制台用浏览器原生 `import()` 加载这个文件，只要求默认导出
 * `{ panels: { <id>: { mount(ctx) } } }`。所以这里不能写 TS、也不能 import 本地模块。
 *
 * 文案、单位、范围都由 World 算好（`radar.status`），这里只负责画。没打开雷达时整块隐藏，
 * 页签标题旁边那句说明会解释为什么是空的。
 */
const COLORS = { ok: '#3ba55d', warn: '#d9a441', bad: '#d9534f', off: '#8a8a8a' };
const POLL_MS = 2000;
const INPUT_CSS = 'width:96px;padding:2px 6px;border-radius:4px;border:1px solid rgba(128,128,128,.45);'
  + 'background:transparent;color:inherit;font:inherit';
const MUTED_CSS = 'font-size:12px;color:var(--muted,#8a8a8a)';

function make(doc, tag, text) {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

const radarPanel = {
  mount(ctx) {
    const doc = ctx.root.ownerDocument;

    const wrap = make(doc, 'div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:14px;max-width:620px;padding:6px 2px';
    ctx.root.appendChild(wrap);

    const status = make(doc, 'div');
    status.style.cssText = 'display:flex;align-items:center;gap:8px';
    const dot = make(doc, 'span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:#8a8a8a';
    const text = make(doc, 'span');
    const hint = make(doc, 'span');
    hint.style.cssText = MUTED_CSS;
    status.append(dot, text, hint);

    const form = make(doc, 'div');
    form.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px 12px;align-items:center';

    const actions = make(doc, 'div');
    actions.style.cssText = 'display:flex;align-items:center;gap:10px';
    const save = make(doc, 'button');
    save.type = 'button';
    const message = make(doc, 'span');
    message.style.cssText = MUTED_CSS;
    actions.append(save, message);

    wrap.append(status, form, actions);

    /** 当前表单项与它们的输入框。 */
    let fields = [];
    let inputs = new Map();
    let labels = { save: 'Save', saved: 'Saved' };
    /** 用户改过还没保存：这期间轮询只动状态行，不覆盖输入框。 */
    let dirty = false;

    const collect = () => {
      const out = {};
      for (const field of fields) {
        const el = inputs.get(field.key);
        if (!el) continue;
        if (field.kind === 'bool') out[field.key] = el.checked;
        else if (field.kind === 'int') {
          const value = Number(el.value);
          if (Number.isFinite(value)) out[field.key] = value;
        } else out[field.key] = el.value;
      }
      return out;
    };

    const syncValues = (payload) => {
      for (const field of payload.fields || []) {
        const el = inputs.get(field.key);
        if (!el) continue;
        if (field.kind === 'bool') el.checked = !!field.value;
        else if (String(el.value) !== String(field.value ?? '')) el.value = String(field.value ?? '');
      }
    };

    const paintStatus = (payload) => {
      const on = !!payload && payload.enabled === true;
      status.style.display = on ? 'flex' : 'none';
      form.style.display = on ? 'grid' : 'none';
      actions.style.display = on ? 'flex' : 'none';
      if (!on) return;
      dot.style.background = COLORS[payload.tone] || COLORS.off;
      text.textContent = payload.text || '';
      hint.textContent = payload.hint || '';
    };

    const buildForm = (payload) => {
      fields = Array.isArray(payload.fields) ? payload.fields : [];
      inputs = new Map();
      form.replaceChildren();
      labels = payload.labels || labels;
      save.textContent = labels.save;
      for (const field of fields) {
        const label = make(doc, 'label', field.label || field.key);
        label.style.cssText = 'font-size:13px';
        const box = make(doc, 'div');
        box.style.cssText = 'display:flex;align-items:center;gap:6px;justify-self:end';
        let el;
        if (field.kind === 'bool') {
          el = make(doc, 'input');
          el.type = 'checkbox';
          el.checked = !!field.value;
        } else {
          el = make(doc, 'input');
          el.type = field.kind === 'int' ? 'number' : 'text';
          if (field.kind === 'int') {
            if (field.min !== undefined) el.min = String(field.min);
            if (field.max !== undefined) el.max = String(field.max);
          }
          el.value = field.value === undefined || field.value === null ? '' : String(field.value);
          el.style.cssText = INPUT_CSS;
        }
        el.addEventListener('input', () => { dirty = true; message.textContent = ''; });
        el.addEventListener('change', () => { dirty = true; message.textContent = ''; });
        inputs.set(field.key, el);
        box.appendChild(el);
        if (field.suffix) {
          const unit = make(doc, 'span', field.suffix);
          unit.style.cssText = MUTED_CSS;
          box.appendChild(unit);
        }
        form.append(label, box);
      }
      dirty = false;
    };

    const refresh = async () => {
      let payload;
      try {
        payload = await ctx.invoke('status');
      } catch (error) {
        // 读不到就藏起来，别把上一次的读数当成现在
        status.style.display = 'none';
        form.style.display = 'none';
        actions.style.display = 'none';
        console.error('[are-you-there] could not read the radar status', error);
        return;
      }
      paintStatus(payload);
      if (!payload || payload.enabled !== true) return;
      if (inputs.size === 0) buildForm(payload);
      else if (!dirty) syncValues(payload);
    };

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const payload = await ctx.invoke('save', [collect()]);
        dirty = false;
        paintStatus(payload);
        if (payload && payload.enabled === true) buildForm(payload);
        message.textContent = labels.saved;
      } catch (error) {
        message.textContent = String((error && error.message) || error);
      } finally {
        save.disabled = false;
      }
    });

    void refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { radar: radarPanel } };
