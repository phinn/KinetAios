// 模拟 keyed 渲染逻辑,复现新建会话出现重复 DOM 的问题
// 提取自 src/renderer/app.ts renderSidebar() + obtainTaskLi()
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag;
    this.dataset = {};
    this.classList = new Set();
    this.children = [];
    this.parent = null;
    this._text = '';
    this._cls = '';
    Object.assign(this.dataset, attrs);
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  appendChild(el) {
    if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el);
    el.parent = this;
    this.children.push(el);
    return el;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (sel === 'li[data-cid]' && c.tagName === 'li' && c.dataset.cid) out.push(c);
        if (sel === 'li.sb-proj[data-cwd]' && c.tagName === 'li' && c.classList.has('sb-proj') && c.dataset.cwd) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    if (sel === '.sb-pcount') return this.children.find(c => c._cls === 'sb-pcount') || null;
    if (sel === '.sb-proj-tasks') return this.children.find(c => c._cls === 'sb-proj-tasks') || null;
    return null;
  }
}

let convs = new Map();
let order = [];
let selectedId = null;
let sidebarMode = 'grouped';

function taskLi(id) {
  const c = convs.get(id);
  const li = new FakeEl('li', { cid: id });
  li._text = `li#${id}@${c.cwd || ''}`;
  return li;
}
function buildProjLi(cwd) {
  const projLi = new FakeEl('li');
  projLi.classList.add('sb-proj');
  projLi.dataset.cwd = cwd;
  const head = new FakeEl('div');
  const count = new FakeEl('span'); count._cls = 'sb-pcount';
  head.appendChild(count);
  projLi.appendChild(head);
  const tasksUl = new FakeEl('ul'); tasksUl._cls = 'sb-proj-tasks';
  projLi.appendChild(tasksUl);
  return projLi;
}
function taskFingerprint(id) {
  const c = convs.get(id);
  return [id === selectedId ? 1 : 0, c.cwd, c.status, c.updatedAt].join('|');
}
function obtainTaskLi(id, pool) {
  const old = pool.get(id);
  pool.delete(id);
  if (old && old.dataset.fp === taskFingerprint(id)) return old;
  const li = taskLi(id);
  li.dataset.fp = taskFingerprint(id);
  return li;
}

const ul = new FakeEl('ul');

function renderSidebar() {
  let visibleOrder = [...new Set(order)];
  const taskPool = new Map();
  ul.querySelectorAll('li[data-cid]').forEach((li) => {
    if (li.dataset.cid) taskPool.set(li.dataset.cid, li);
  });
  const projPool = new Map();
  if (sidebarMode !== 'flat') {
    ul.querySelectorAll('li.sb-proj[data-cwd]').forEach((li) => {
      if (li.dataset.cwd) projPool.set(li.dataset.cwd, li);
    });
  }

  if (sidebarMode === 'flat') {
    for (const id of visibleOrder) {
      if (!convs.get(id)) continue;
      ul.appendChild(obtainTaskLi(id, taskPool));
    }
  } else {
    const groups = new Map();
    for (const id of visibleOrder) {
      const c = convs.get(id);
      if (!c) continue;
      const key = c.cwd || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    for (const [cwd, ids] of groups) {
      let projLi = projPool.get(cwd);
      projPool.delete(cwd);
      if (!projLi) projLi = buildProjLi(cwd);
      const tasksUl = projLi.querySelector('.sb-proj-tasks');
      for (const id of ids) {
        if (!convs.get(id)) continue;
        tasksUl.appendChild(obtainTaskLi(id, taskPool));
      }
      ul.appendChild(projLi);
    }
  }
  taskPool.forEach((li) => li.remove());
  projPool.forEach((li) => li.remove());
}

function dump(tag) {
  const items = ul.querySelectorAll('li[data-cid]').map(li => li.dataset.cid);
  const dups = items.filter((c, i) => items.indexOf(c) !== i);
  const groups = ul.querySelectorAll('li.sb-proj[data-cwd]').map(p => ({
    cwd: p.dataset.cwd.split('/').pop(),
    n: p.querySelectorAll('li[data-cid]').length,
  }));
  console.log(tag, JSON.stringify({ items, dups, groups }));
}

// ── 场景 1:正常新建 ──
console.log('=== 场景 1: 新建会话标准流程 ===');
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar(); dump('初始(会话a):');
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.unshift('b');
selectedId = 'b';
renderSidebar(); dump('新建b后:');

// ── 场景 2:未分类 → cwd 回填 ──
console.log('=== 场景 2: 新建(b)在未分类,cwd 回填 ===');
convs = new Map(); order = []; selectedId = null;
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar(); dump('初始:');
convs.set('b', { cwd: '', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar(); dump('b 落未分类:');
convs.get('b').cwd = '/proj/x';
renderSidebar(); dump('b 回填 cwd 后:');

// ── 场景 3:onclick 渲染在前,广播在后 ──
console.log('=== 场景 3: 渲染时 convs 无该 id ===');
convs = new Map(); order = []; selectedId = null;
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar(); dump('初始:');
selectedId = 'b';
renderSidebar(); dump('onclick 渲染(b 不在 convs):');
convs.set('b', { cwd: '', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar(); dump('广播到达后:');

// ── 场景 4:同一会话广播两次(主进程 emitConversation 重复)──
console.log('=== 场景 4: 同一 conv 广播两次(order 已含) ===');
convs = new Map(); order = []; selectedId = null;
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar(); dump('初始:');
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar(); dump('b 首次:');
order.unshift('b'); // 模拟 order 重复添加
renderSidebar(); dump('order=[b,a,b] 去重后:');

// ── 场景 5:cwd 从 /proj/x → '' (setCwd 清空)→ 再回填 ──
console.log('=== 场景 5: cwd 变更往返 ===');
convs = new Map(); order = []; selectedId = null;
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.push('a', 'b');
renderSidebar(); dump('初始两话同组:');
convs.get('b').cwd = '';
renderSidebar(); dump('b 变未分类:');
convs.get('b').cwd = '/proj/y';
renderSidebar(); dump('b 变新组 /proj/y:');

// ── 场景 6:project header 的 .sb-pcount 与实际子节点数不一致的检测 ──
console.log('=== 场景 6: 计数一致性 ===');
convs = new Map(); order = []; selectedId = null;
convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
order.push('a');
renderSidebar();
const proj = ul.querySelectorAll('li.sb-proj[data-cwd]')[0];
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.unshift('b');
renderSidebar();
console.log('proj x 子节点:', proj.querySelectorAll('li[data-cid]').length, '计数文本: b 加入后全量重渲,旧 projLi 引用可能失效(正常)');
