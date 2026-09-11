// 精确定位:场景5中重复的 b 到底挂在哪
const path = require('path');
// 重跑场景5,但每步后 dump 整棵树
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
  if (old && old.dataset.fp === taskFingerprint(id)) return old;
  const li = taskLi(id); li.dataset.fp = taskFingerprint(id);
  return li;
}
const ul = new FakeEl('ul');
function renderSidebar() {
  let visibleOrder = [...new Set(order)];
  const taskPool = new Map();
  ul.querySelectorAll('li[data-cid]').forEach((li) => { if (li.dataset.cid) taskPool.set(li.dataset.cid, li); });
  const projPool = new Map();
  ul.querySelectorAll('li.sb-proj[data-cwd]').forEach((li) => { if (li.dataset.cwd) projPool.set(li.dataset.cwd, li); });
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
    }
    ul.appendChild(projLi);
  }
  taskPool.forEach((li) => li.remove());
  projPool.forEach((li) => li.remove());
}
function dump(tag) {
  console.log(`\n──── ${tag} ────`);
  console.log(ul.tree().trim());
}

convs.set('a', { cwd: '/proj/x', status: 'ready', updatedAt: 1 });
convs.set('b', { cwd: '/proj/x', status: 'ready', updatedAt: 2 });
order.push('a', 'b');
renderSidebar(); dump('初始 a,b 都在 x 组');

convs.get('b').cwd = '';
renderSidebar(); dump('b → 未分类(cwd="")后:观察 b 是否残留 x 组');

convs.get('b').cwd = '/proj/y';
renderSidebar(); dump('b → /proj/y 后:观察重复');
