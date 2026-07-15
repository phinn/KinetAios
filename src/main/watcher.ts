// Watch 模式:<cwd>/.kinet-watch.json 配置 glob + prompt,文件改动 → debounce → 起 agent 任务。
// ponytail:用 Node fs.watch recursive(mac/win 原生,Linux 不支持但本项目目标 Windows)。
// 不用 chokidar —— 多一个依赖多一份维护,recursive 在 mac/win 上够稳。
// 多个会话共享同 cwd → 只起一个 watcher(Map by cwd)。
import fs from 'node:fs';
import path from 'node:path';
import type { TaskManager } from './TaskManager';

export interface WatchRule {
  glob: string;       // 相对 cwd 的 glob,** 跨目录、* 单段
  prompt: string;     // 任务模板,支持 ${file} ${event}
  debounceMs?: number;// 默认 500ms
}

export interface WatchConfig {
  rules: WatchRule[];
}

interface WatcherEntry {
  fw: fs.FSWatcher;
  config: WatchConfig;
  // debounce per (ruleIndex + file),防止编辑器保存连发多次。
  timers: Map<string, NodeJS.Timeout>;
}

const watchers = new Map<string, WatcherEntry>();
let taskManager: TaskManager | null = null;

export function setTaskManagerForWatchers(tm: TaskManager): void {
  taskManager = tm;
}

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'release', 'build', '.next', 'target', '.cache', '__pycache__', 'venv', '.venv'];

// glob → regex 逻辑已提取到 shared/glob.ts,与 tools.ts 共用一份。
import { globToRegex } from '../shared/glob';

function loadConfig(cwd: string): WatchConfig | null {
  const p = path.join(cwd, '.kinet-watch.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rules)) return null;
    return { rules: parsed.rules.filter((r: WatchRule) => r && typeof r.glob === 'string' && typeof r.prompt === 'string') };
  } catch {
    return null;
  }
}

export function startWatcher(cwd: string): boolean {
  if (!cwd || watchers.has(cwd)) return false;
  const config = loadConfig(cwd);
  if (!config || !config.rules.length) return false;
  let fw: fs.FSWatcher;
  try {
    // recursive 在 mac/win 是原生,linux 不可。本项目目标 Windows,够用。
    fw = fs.watch(cwd, { recursive: true });
  } catch (e) {
    console.warn('watch start failed', cwd, e);
    return false;
  }
  const entry: WatcherEntry = { fw, config, timers: new Map() };
  fw.on('change', (eventType: string, filename: string | null) => {
    if (!filename) return;
    // 跳 node_modules 等(虽然 recursive 也会上报,这里兜底过滤)。
    const parts = filename.split(/[\\/]/);
    if (parts.some((p) => SKIP_DIRS.includes(p))) return;
    // 临时文件(swpx/tilde 等)也跳。
    if (/\.(swpx|swp|tmp|bak)$|~$|^\./.test(path.basename(filename))) return;
    for (let i = 0; i < config.rules.length; i++) {
      const rule = config.rules[i];
      const re = globToRegex(rule.glob);
      if (re.test(filename.replace(/\\/g, '/'))) {
        schedule(entry, cwd, i, rule, filename, eventType);
        return; // 第一个匹配的规则吃,避免一条改动触发多个任务
      }
    }
  });
  fw.on('error', (e) => {
    console.warn('watch error', cwd, e);
  });
  watchers.set(cwd, entry);
  return true;
}

function schedule(entry: WatcherEntry, cwd: string, ruleIdx: number, rule: WatchRule, file: string, event: string): void {
  const key = `${ruleIdx}:${file}`;
  const prev = entry.timers.get(key);
  if (prev) clearTimeout(prev);
  const ms = rule.debounceMs ?? 500;
  const t = setTimeout(() => {
    entry.timers.delete(key);
    fire(cwd, rule, file, event);
  }, ms);
  entry.timers.set(key, t);
}

function fire(cwd: string, rule: WatchRule, file: string, event: string): void {
  if (!taskManager) return;
  try {
    const prompt = rule.prompt
      .replace(/\$\{file\}/g, file)
      .replace(/\$\{event\}/g, event);
    // 起新会话发任务。这样 watch 触发的多次任务彼此独立,不串上下文。
    const conv = taskManager.newConversation(cwd);
    taskManager.send(conv.id, prompt);
  } catch (e) {
    console.warn('watch fire failed', e);
  }
}

export function stopWatcher(cwd: string): void {
  const e = watchers.get(cwd);
  if (!e) return;
  for (const t of e.timers.values()) clearTimeout(t);
  try {
    e.fw.close();
  } catch {
    /* 兜底 */
  }
  watchers.delete(cwd);
}

export function listWatchers(): string[] {
  return Array.from(watchers.keys());
}

// 启动时 / 创建新会话时调,自动检测 .kinet-watch.json 并起 watcher。
export function ensureWatcher(cwd: string): void {
  if (!cwd) return;
  if (watchers.has(cwd)) {
    // 已有 watcher,但配置可能改了 —— 重新读一遍(关闭重开)。
    const p = path.join(cwd, '.kinet-watch.json');
    if (!fs.existsSync(p)) {
      stopWatcher(cwd);
      return;
    }
  } else {
    startWatcher(cwd);
  }
}
