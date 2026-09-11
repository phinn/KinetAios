// 验证修复:renderedCids 清理策略
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag; this.dataset = {}; this.classList = new Set();
    this.children = []; this.parent = null; this._text = ''; this._cls = '';
    Object.assign(this.dataset, attrs);
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  appendChild(el) {
    if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el);
    el.parent = this; this.children.push(el); return el;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) {
      if (sel === 'li[data-cid]' && c.tagName === 'li' && c.dataset.cid) out.push(c);
      if (sel === 'li.sb-proj[data-cwd]' && c.tagName === 'li' && c.classList.has('sb-proj') && c.dataset.cwd) out.push(c);
      walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) {
    if (sel === '.sb-pcount') return this.children.find(c => c._cls === 'sb-pcount') || null;
    if (sel === '.sb-proj-tasks') return this.children.find(c => c._cls === 'sb-proj-tasks') || null;
    return null;
  }
  tree(indent = 0) {
    const pad = '  '.repeat(indent);
    const label = this.tagName === 'li'
      ? (this.classList.has('sb-proj') ? `sb-proj[${this.dataset.cwd}]` : `li[data-cid=${this.dataset.cid}]`)
      : this.tagName + (this._cls ? `.${this._cls}` : '');
    let s = pad + label + (this.dataset.cid ? ` {${this._text}}` : '') + '\n';
    for (const c of this.children) s += c.tree(indent + 1);
    return s;
  }
}

let convs = new Map(), order = [], selectedId = null;
let sidebarMode = 'grouped';
function taskLi(id) {
  const li = new FakeEl('li', { cid: id });
  li._text = `${id}@${convs.get(id).cwd || '(未分类)'}`;
  return li;
}
function buildProjLi(cwd) {
  const projLi = new FakeEl('li'); projLi.classList.add('sb-proj'); projLi.dataset.cwd = cwd;
  const head = new FakeEl('div');
  const count = new FakeEl('span'); count._cls = 'sb-pcount';
  head.appendChild(count); projLi.appendChild(head);
  const tasksUl = new FakeEl('ul'); tasksUl._cls = 'sb-proj-tasks';
  projLi.appendChild(tasksUl);
  return projLi;
}
function taskFingerprint(id) {
  const c = convs.get(id);
  return [id === selectedId ? 1 : 0, c.cwd, c.status, c.updatedAt].join('|');
}
function obtainTaskLi(id, pool) {
  const old = pool.get(id); pool.delete(id);
  if (old && old.dataset.fp === taskFingerprint(id)) { old.remove(); return old; }
  if (old) old.remove();
  const li = taskLi(id); li.dataset.fp = taskFingerprint(id);
  return li;
}
const ul = new FakeEl('ul');
function renderSidebar() {
  let visibleOrder = [...new Set(order)];
  const taskPool = new Map();
  ul.querySelectorAll('li[data-cid]').forEach((li) => { if (li.dataset.cid) taskPool.set(li.dataset.cid, li); });
  const projPool = new Map();
  if (sidebarMode !== 'flat') {
    ul.querySelectorAll('li.sb-proj[data-cwd]').forEach((li) => { if (li.dataset.cwd) projPool.set(li.dataset.cwd, li); });
  }
  const renderedCids = new Set(); // ── 修复点 ──
  if (sidebarMode === 'flat') {
    for (const id of visibleOrder) {
      if (!convs.get(id)) continue;
      ul.appendChild(obtainTaskLi(id, taskPool));
      renderedCids.add(id);
    }
  } else {
    const groups = new Map();
    for (const id of visibleOrder) {
      const c = convs.get(id); if (!c) continue;
      const key = c.cwd || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    for (const [cwd, ids] of groups) {
      let projLi = projPool.get(cwd); projPool.delete(cwd);
      if (!projLi) projLi = buildProjLi(cwd);
      const tasksUl = projLi.querySelector('.sb-proj-tasks');
      for (const id of ids) {
        if (!convs.get(id)) continue;
        tasksUl.appendChild(obtainTaskLi(id, taskPool));
        renderedCids.add(id);
      }
      ul.appendChild(projLi);
    }
  }
  taskPool.forEach((li, cid) => { if (!renderedCids.has(cid)) li.remove(); });
  projPool.forEach((li) => li.remove());
}
function check(tag) {
  const items = ul.querySelectorAll('li[data-cid]').map(li => li.dataset.cid);
  const dups = items.filter((c, i) => items.indexOf(c) !== i);
  console.log(`${dups.length ? '❌ DUP' : '✅ OK '} ${tag} items=[${items}]`);
  return dups.length === 0;
}

let pass = 0, total = 0;
function t(fn) { total++; if (fn()) pass++; }

// 场景 A:cwd 回填(原 bug 场景2)
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar();
convs.set('b', { cwd: '', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar();
convs.get('b').cwd = '/proj/x';
renderSidebar();
t(() => check('A: 未分类→回填cwd'));

// 场景 B:cwd 两次变更(原 bug 场景5)
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.push('a', 'b');
renderSidebar();
convs.get('b').cwd = '';
renderSidebar();
convs.get('b').cwd = '/proj/y';
renderSidebar();
t(() => check('B: x→未分类→y 连续换组'));

// 场景 C:删除会话
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.push('a', 'b');
renderSidebar();
convs.delete('b'); order = order.filter(x => x !== 'b');
renderSidebar();
t(() => check('C: 删除会话'));

// 场景 D:flat ↔ grouped 切换
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
sidebarMode = 'flat';
renderSidebar();
sidebarMode = 'grouped';
renderSidebar();
t(() => check('D: flat↔grouped 切换'));

// 场景 E:grouped → flat(嵌套 li 残留检测)
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
sidebarMode = 'grouped';
renderSidebar();
sidebarMode = 'flat';
renderSidebar();
t(() => check('E: grouped→flat 切换'));

// 场景 F:新建会话完整流程(onclick渲染+广播)
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar();
selectedId = 'b'; renderSidebar();           // onclick 时 convs 无 b
convs.set('b', { cwd: '', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar();                              // 广播到
convs.get('b').cwd = '/proj/x';              // 首条消息回填 cwd
renderSidebar();
t(() => check('F: 新建完整链路'));

// 场景 G:重复广播
convs = new Map(); order = []; selectedId = null; ul.children = [];
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar();
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar();
order.unshift('b'); // 模拟异常重复
renderSidebar();
t(() => check('G: order 疑似重复(去重保险)'));

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
