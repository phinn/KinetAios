// Computer Use: screenshot + mouse + keyboard via OS-native APIs.
// No external native deps — uses Electron desktopCapturer for screenshots,
// PowerShell System.Windows.Forms on Windows, cliclick on macOS.
// 计算机使用:截屏 + 鼠标 + 键盘,无原生依赖。
// Screenshots: Electron desktopCapturer (main process).
// Mouse/Keyboard: PowerShell (Windows) / cliclick (macOS) / xdotool (Linux).
import { desktopCapturer, screen as electronScreen, BrowserWindow } from 'electron';
import { exec } from 'node:child_process';

// ── Screenshot ── 截屏,返回 base64 PNG + 屏幕尺寸
export interface ScreenshotResult {
  ok: boolean;
  dataUrl?: string;       // data:image/png;base64,xxxx
  base64?: string;        // 纯 base64(不含 data: 前缀)
  width?: number;
  height?: number;
  error?: string;
}

export async function captureScreenshot(): Promise<ScreenshotResult> {
  return captureScreenshotWithHide(false);
}

// hide_self=true: 截图前最小化本 app 所有可见窗口,截完还原 —— 用户不用手动移开 KinetAios。
// Hide own windows before capture, restore after — so KinetAios itself isn't in the shot.
export async function captureScreenshotWithHide(hideSelf: boolean): Promise<ScreenshotResult> {
  return withSelfHidden(hideSelf, captureScreenInner);
}

// 通用包装:最小化自身窗口 → 执行 fn → 还原。供按钮截图等其他截图路径复用。
// Generic wrapper: minimize own windows → run fn → restore. Reusable by other capture paths.
export async function withSelfHidden<T>(hideSelf: boolean, fn: () => Promise<T>): Promise<T> {
  const hidden: BrowserWindow[] = [];
  if (hideSelf) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isVisible() && !w.isMinimized()) {
        w.minimize();
        hidden.push(w);
      }
    }
    if (hidden.length) await new Promise((r) => setTimeout(r, 350));
  }
  try {
    return await fn();
  } finally {
    for (const w of hidden) {
      try { w.restore(); } catch { /* already gone */ }
    }
  }
}

async function captureScreenInner(): Promise<ScreenshotResult> {
  try {
    const primaryDisplay = electronScreen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const dpr = primaryDisplay.scaleFactor || 1;
    // 请求物理像素分辨率(×dpr),但缩放到合理尺寸防止太大
    const targetW = Math.min(Math.round(width * dpr), 2560);
    const targetH = Math.min(Math.round(height * dpr), 1440);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetW, height: targetH },
    });
    if (!sources.length) return { ok: false, error: 'No screen found' };
    const source = sources.find((s) => s.display_id === String(primaryDisplay.id)) || sources[0];
    const thumb = source.thumbnail;
    if (thumb.isEmpty()) return { ok: false, error: 'Screenshot empty (screen permission?)' };
    const dataUrl = thumb.toDataURL();
    if (!dataUrl || dataUrl.length < 1000) return { ok: false, error: 'Screenshot too small' };
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { ok: true, dataUrl, base64, width: targetW, height: targetH };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Mouse actions ── 鼠标操作
// Windows: PowerShell + System.Windows.Forms.Cursor (built-in, zero deps)
// macOS: cliclick (brew install cliclick)
// Linux: xdotool
export interface MouseClickArgs {
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  doubleClick?: boolean;
}

export async function mouseClick(args: MouseClickArgs): Promise<{ ok: boolean; error?: string }> {
  const { x, y, button = 'left', doubleClick = false } = args;
  const platform = process.platform;

  try {
    // 后台模式:PostMessage/CGEventPostToPid 投递,真实光标/焦点不动
    if (computerUseBackground()) {
      if (platform === 'win32') {
        const r = await bgMouseClickWin(x, y, button, doubleClick);
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? '后台点击失败' };
      }
      if (platform === 'darwin') return bgClickMac(x, y, button, doubleClick);
      // Linux 无可靠等价 API → 回落前台
    }
    return clickForeground(x, y, button, doubleClick, platform);
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 前台点击(原实现抽出,后台模式在非 Windows 上也复用)
async function clickForeground(x: number, y: number, button: 'left' | 'right' | 'middle', doubleClick: boolean, platform: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (platform === 'win32') {
      // PowerShell: move cursor then click via user32.dll
      // Use [System.Windows.Forms.Cursor]::Position to move, then mouse_event for click.
      const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
      const downUp = doubleClick
        ? btn === 'right'
          ? 'rightdown,rightup,rightdown,rightup'
          : btn === 'middle'
            ? 'middledown,middleup,middledown,middleup'
            : 'leftdown,leftup,leftdown,leftup'
        : btn === 'right'
          ? 'rightdown,rightup'
          : btn === 'middle'
            ? 'middledown,middleup'
            : 'leftdown,leftup';
      // mouse_event constants: LEFTDOWN=2 LEFTUP=4 RIGHTDOWN=8 RIGHTUP=16 MIDDLEDOWN=32 MIDDLEUP=64
      const flagMap: Record<string, string> = {
        leftdown: '2', leftup: '4',
        rightdown: '8', rightup: '16',
        middledown: '32', middleup: '64',
      };
      const flags = downUp.split(',').map((f) => flagMap[f]).join(',');
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})
Start-Sleep -Milliseconds 30
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
}
"@
${flags.split(',').map((f: string) => `[Mouse]::mouse_event(${f}, 0, 0, 0, 0)`).join('\nStart-Sleep -Milliseconds 20\n')}
`.trim();
      await runShell(ps, 5000);
      return { ok: true };
    } else if (platform === 'darwin') {
      const btnFlag = button === 'right' ? '-r' : '';
      const dcFlag = doubleClick ? '--double' : '';
      // cliclick uses screen pixel coords (not scaled by dpr on macOS)
      await runShell(`cliclick ${dcFlag} ${btnFlag} c:${Math.round(x)},${Math.round(y)}`, 5000);
      return { ok: true };
    } else {
      // Linux: xdotool
      const btnNum = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      const dcCmd = doubleClick ? `--repeat 2` : '';
      await runShell(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click ${dcCmd} ${btnNum}`, 5000);
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Mouse move (no click) ── 仅移动光标
// 后台模式下 move 无意义(没有真实光标操作),直接成功返回。
export async function mouseMove(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  if (computerUseBackground()) return { ok: true }; // 后台模式:无光标可移,no-op
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})`;
      await runShell(ps, 3000);
    } else if (process.platform === 'darwin') {
      await runShell(`cliclick m:${Math.round(x)},${Math.round(y)}`, 3000);
    } else {
      await runShell(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`, 3000);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Mouse scroll ── 滚轮滚动
export async function mouseScroll(x: number, y: number, clicks: number): Promise<{ ok: boolean; error?: string }> {
  // 后台模式:WM_MOUSEWHEEL / CGEvent 滚轮直接投给坐标命中窗口
  if (computerUseBackground()) {
    if (process.platform === 'win32') return bgMouseScrollWin(x, y, clicks);
    if (process.platform === 'darwin') return bgScrollMac(x, y, clicks);
    // Linux 回落前台滚动
  }
  try {
    if (process.platform === 'win32') {
      // Move to position first, then scroll via mouse_event wheel flag (0x0800)
      const dir = clicks >= 0 ? 1 : -1; // positive = scroll down on Windows wheel_delta
      const amount = Math.abs(clicks) * 120 * dir; // WHEEL_DELTA = 120
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})
Start-Sleep -Milliseconds 20
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Wheel {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
}
"@
[Wheel]::mouse_event(0x0800, 0, 0, ${Math.round(amount)}, 0)
`.trim();
      await runShell(ps, 3000);
    } else if (process.platform === 'darwin') {
      // cliclick scroll: positive = up, negative = down
      await runShell(`clicclick "m:${Math.round(x)},${Math.round(y)}" "wd:${Math.round(clicks * 2)}"`, 3000);
    } else {
      await runShell(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click ${clicks > 0 ? '4' : '5'}`, 3000);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Mouse drag ── 拖拽(从一点拖到另一点)
// 后台模式:拖拽本质是"按住移动",PostMessage 没有天然的跨坐标按住语义 ——
// 降级为"down@起点 → up@终点"两次投递,只对支持 WM_LBUTTONDOWN 拖拽选择的
// 目标有效(文本选区/滑块多数可用;拖拽式 DnD 不行)。这是模式边界,如实返回。
export async function mouseDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: boolean; error?: string }> {
  if (computerUseBackground()) {
    if (process.platform === 'win32') {
      return bgDragWin(fromX, fromY, toX, toY);
    }
    if (process.platform === 'darwin') return bgDragMac(fromX, fromY, toX, toY);
    // Linux 回落前台
  }
  try {
    if (process.platform === 'win32') {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(fromX)},${Math.round(fromY)})
Start-Sleep -Milliseconds 50
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Drag {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
}
"@
[Drag]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(toX)},${Math.round(toY)})
Start-Sleep -Milliseconds 80
[Drag]::mouse_event(4, 0, 0, 0, 0)
`.trim();
      await runShell(ps, 5000);
    } else if (process.platform === 'darwin') {
      await runShell(`cliclick dd:${Math.round(fromX)},${Math.round(fromY)} ${Math.round(toX)},${Math.round(toY)}`, 5000);
    } else {
      await runShell(`xdotool mousemove ${Math.round(fromX)} ${Math.round(fromY)} mousedown 1 mousemove ${Math.round(toX)} ${Math.round(toY)} mouseup 1`, 5000);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Keyboard: type text ── 输入文本
export async function keyboardType(text: string): Promise<{ ok: boolean; error?: string }> {
  // 后台模式:WM_CHAR / Unicode keydown 投给上次点击锁定的窗口
  if (computerUseBackground()) {
    if (process.platform === 'win32') return bgKeyboardTypeWin(text);
    if (process.platform === 'darwin') return bgTypeMac(text);
    // Linux 回落前台
  }
  try {
    if (process.platform === 'win32') {
      // Use SendKeys with proper escaping: {} characters are special in SendKeys
      const escaped = text
        .replace(/[{}()[\]^%+]/g, '{$&}')  // escape special SendKeys chars
        .replace(/[\r\n]/g, '{ENTER}');
      const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`;
      await runShell(ps, 10000);
    } else if (process.platform === 'darwin') {
      // cliclick -t types text
      await runShell(`cliclick -t ${shellEscape(text)}`, 10000);
    } else {
      await runShell(`xdotool type -- ${shellEscape(text)}`, 10000);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Keyboard: press key combo ── 按键(支持组合键如 Ctrl+C)
export async function keyboardKey(key: string): Promise<{ ok: boolean; error?: string }> {
  // 后台模式:VK/虚拟键码 KEYDOWN-KEYUP 投给锁定窗口
  if (computerUseBackground()) {
    if (process.platform === 'win32') return bgKeyboardKeyWin(key);
    if (process.platform === 'darwin') return bgKeyMac(key);
    // Linux 回落前台
  }
  try {
    // Normalize key names
    // OpenAI computer use style: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, etc.
    // Also support combos: Ctrl+C, Shift+Home, etc.
    if (process.platform === 'win32') {
      // Map to SendKeys format
      const sendKeysMap: Record<string, string> = {
        'enter': '{ENTER}',
        'return': '{ENTER}',
        'tab': '{TAB}',
        'escape': '{ESC}',
        'esc': '{ESC}',
        'backspace': '{BS}',
        'delete': '{DEL}',
        'del': '{DEL}',
        'home': '{HOME}',
        'end': '{END}',
        'pageup': '{PGUP}',
        'pagedown': '{PGDN}',
        'arrowup': '{UP}',
        'arrowdown': '{DOWN}',
        'arrowleft': '{LEFT}',
        'arrowright': '{RIGHT}',
        'space': ' ',
        'ctrl': '^',
        'control': '^',
        'shift': '+',
        'alt': '%',
        'meta': '^', // Windows: treat Meta as Ctrl for shortcuts
        'cmd': '^',
        'command': '^',
        'win': '{WIN}',
      };
      // Handle combos: "Ctrl+C" → "^{c}" in SendKeys
      const parts = key.split('+').map((p) => p.trim());
      if (parts.length > 1) {
        // Combo: modifiers + final key
        const modifiers = parts.slice(0, -1).map((m) => sendKeysMap[m.toLowerCase()] || '').join('');
        const finalKey = parts[parts.length - 1];
        const finalMapped = sendKeysMap[finalKey.toLowerCase()];
        const finalStr = finalMapped || (finalKey.length === 1 ? finalKey : `{${finalKey}}`);
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${modifiers}${finalStr}')`;
        await runShell(ps, 5000);
      } else {
        // Single key
        const mapped = sendKeysMap[key.toLowerCase()] || key;
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${mapped.replace(/'/g, "''")}')`;
        await runShell(ps, 5000);
      }
    } else if (process.platform === 'darwin') {
      // cliclick key codes are different (kp:enter, kp:tab, etc.)
      const cliclickMap: Record<string, string> = {
        'enter': 'return', 'return': 'return',
        'tab': 'tab', 'escape': 'escape', 'esc': 'escape',
        'backspace': 'delete', 'delete': 'forwarddelete', 'del': 'forwarddelete',
        'home': 'home', 'end': 'end',
        'pageup': 'pageup', 'pagedown': 'pagedown',
        'arrowup': 'up', 'arrowdown': 'down', 'arrowleft': 'left', 'arrowright': 'right',
        'space': 'space',
      };
      const parts = key.split('+').map((p) => p.trim());
      if (parts.length > 1) {
        const modifiers = parts.slice(0, -1).map((m) => {
          const lm = m.toLowerCase();
          if (lm === 'ctrl' || lm === 'control') return 'cmd'; // macOS: Ctrl maps to Cmd for most shortcuts
          if (lm === 'alt' || lm === 'option') return 'alt';
          if (lm === 'shift') return 'shift';
          if (lm === 'cmd' || lm === 'meta' || lm === 'command') return 'cmd';
          return m.toLowerCase();
        });
        const finalKey = cliclickMap[parts[parts.length - 1].toLowerCase()] || parts[parts.length - 1].toLowerCase();
        const combo = [...modifiers, finalKey].join('+');
        await runShell(`cliclick kp:${combo}`, 5000);
      } else {
        const mapped = cliclickMap[key.toLowerCase()] || key.toLowerCase();
        await runShell(`cliclick kp:${mapped}`, 5000);
      }
    } else {
      // Linux: xdotool key
      const xdotoolKey = key.toLowerCase()
        .replace('arrow', '').replace('ctrl', 'ctrl').replace('cmd', 'super')
        .replace('enter', 'Return').replace('escape', 'Escape').replace('tab', 'Tab')
        .replace('backspace', 'BackSpace').replace('delete', 'Delete')
        .replace('arrowup', 'Up').replace('arrowdown', 'Down')
        .replace('arrowleft', 'Left').replace('arrowright', 'Right');
      await runShell(`xdotool key ${xdotoolKey}`, 5000);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Background mode (no cursor movement) ── 后台模式(不动光标) ──
// Windows: WindowFromPoint 找到坐标命中的顶层窗口(WS_EX_TRANSPARENT 穿透窗自动跳过),
// 坐标转客户区后用 PostMessage 投递 WM_* 消息 —— 事件直接进目标窗口消息队列,
// 真实光标不动、焦点不抢,用户可继续干自己的事。带 MA_ACTIVATE 标志 = 点击时后台
// 激活该窗口但不置顶不抢前台焦点。键盘投给"最后一次后台点击"命中的窗口(无状态
// 跟踪键鼠宿主关系时的最合理近似)。仅 Windows 有可靠等价实现;macOS 的
// CGEventPostToPid 对现代 App(沙盒/secure event input)不可靠,Linux 无等价 API,
// 两者回落前台方式并在返回值注明。工具往返历史会带图消息,注意别把截图 base64
// 拼进任何日志。
// Windows background delivery: WindowFromPoint resolves the top-level window under
// the point (skipping clickthrough WS_EX_TRANSPARENT), converts to client coords and
// PostMessages WM_* messages — the real cursor never moves and foreground focus stays
// put. MA_ACTIVATE activates the target in the background on click without z-order or
// focus steal. Keyboard goes to the window hit by the last background click (best
// approximation without full focus tracking). macOS/Linux lack a reliable equivalent
// (CGEventPostToPid breaks on sandboxed/secure-input apps) and fall back to the
// foreground path, noted in the result.

let bgLastClickHwnd: number | null = null; // 后台键盘宿主:最后一次后台点击命中的窗口 / keyboard target from last bg click
let bgLastClickPid: number | null = null;  // macOS 侧同语义:最后一次后台点击命中的进程 / same on macOS (pid)

// 开关读取:settings.computerUseBackground(动态 require 避免循环依赖)。
// / Read the background toggle from settings (dynamic require avoids a circular import).
function computerUseBackground(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSettings } = require('./settings') as typeof import('./settings');
    return Boolean(getSettings().computerUseBackground);
  } catch {
    return false;
  }
}

// ── macOS background delivery (JXA) ── macOS 后台投递 ──
// 系统自带 osascript -l JavaScript + ObjC bridge 调 CoreGraphics,零新增依赖:
//   定位:CGWindowListCopyWindowInfo(z 序)→ JS 内 hit-test 点 → 取 kCGWindowOwnerPID
//   投递:CGEventPostToPid —— 事件直接进目标进程队列,全局光标/焦点完全不动
// 权限域与 cliclick 相同(Accessibility);坐标语义与 cliclick 分支完全一致(直接透传)。
// macOS background delivery via the stock osascript JXA + ObjC bridge (no new deps):
// hit-test the z-ordered CGWindowList for the pid, then CGEventPostToPid so events go
// straight into the target process — global cursor/focus untouched. Same TCC domain
// as cliclick; coordinate semantics identical to the cliclick branch.

async function osascriptJxa(script: string, timeoutMs: number): Promise<string> {
  // -e 必须显式:缺了它 osascript 把脚本当文件路径,报 No such file or directory。
  // / -e is mandatory — without it osascript treats the script as a filename.
  return runShellCapture(`osascript -l JavaScript -e ${shellEscape(script)}`, timeoutMs);
}

// 命中测试 JXA 片段:CGWindowListCopyWindowInfo 返回的 CFArray 在 macOS 14+ 上
// ObjC.deepUnwrap 直接返回 undefined(实机验证),必须 castRefToObject 桥接逐键读。
// / The CGWindowList CFArray can NOT be ObjC.deepUnwrap'd (verified: undefined on
// / macOS 14+). Bridge via ObjC.castRefToObject and read dict keys manually.
// 前置:调用方脚本已定义 hx/hy(命中点);效果:设置 var pid(0=未命中)。
function jxaHitTest(): string {
  return `
var pid = 0;
{
  var cglist = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
  for (var gi = 0; gi < cglist.count; gi++) {
    var wd = cglist.objectAtIndex(gi);
    if (Number(ObjC.unwrap(wd.objectForKey('kCGWindowLayer'))) !== 0) continue;
    var b = wd.objectForKey('kCGWindowBounds');
    var bx = Number(ObjC.unwrap(b.objectForKey('X')));
    var by = Number(ObjC.unwrap(b.objectForKey('Y')));
    var bw = Number(ObjC.unwrap(b.objectForKey('Width')));
    var bh = Number(ObjC.unwrap(b.objectForKey('Height')));
    if (hx >= bx && hx < bx + bw && hy >= by && hy < by + bh) { pid = Number(ObjC.unwrap(wd.objectForKey('kCGWindowOwnerPID'))); break; }
  }
}`;
}

async function bgClickMac(x: number, y: number, button: 'left' | 'right' | 'middle', doubleClick: boolean): Promise<{ ok: boolean; error?: string }> {
  const down = button === 'right' ? '$.kCGEventRightMouseDown' : button === 'middle' ? '$.kCGEventOtherMouseDown' : '$.kCGEventLeftMouseDown';
  const up = button === 'right' ? '$.kCGEventRightMouseUp' : button === 'middle' ? '$.kCGEventOtherMouseUp' : '$.kCGEventLeftMouseUp';
  const mb = button === 'right' ? '$.kCGMouseButtonRight' : button === 'middle' ? '$.kCGMouseButtonCenter' : '$.kCGMouseButtonLeft';
  const clicks = doubleClick ? 2 : 1;
  // 命中测试 + 投递一段式脚本:z 序遍历 on-screen 窗口(layer 0、bounds 含点)→ CGEventPostToPid
  const full = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var hx = ${Math.round(x)}, hy = ${Math.round(y)};
${jxaHitTest()}
if (!pid) { 'ERR nopoint' } else {
  var pt = { x: hx, y: hy };
  var n = ${clicks};
  for (var c = 0; c < n; c++) {
    var d = $.CGEventCreateMouseEvent($(), ${down}, pt, ${mb});
    $.CGEventPostToPid(pid, d);
    var u = $.CGEventCreateMouseEvent($(), ${up}, pt, ${mb});
    $.CGEventPostToPid(pid, u);
  }
  'OK ' + pid;
}
`;
  try {
    const out = (await osascriptJxa(full, 8000)).trim();
    const m = /OK (\d+)/.exec(out);
    if (out.includes('ERR nopoint') || !m) return { ok: false, error: '坐标处未命中窗口' };
    bgLastClickPid = Number(m[1]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

async function bgScrollMac(x: number, y: number, clicks: number): Promise<{ ok: boolean; error?: string }> {
  const script = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var hx = ${Math.round(x)}, hy = ${Math.round(y)};
${jxaHitTest()}
if (!pid) { 'ERR nopoint' } else {
  var n = ${Math.max(1, Math.min(30, Math.abs(Math.round(clicks))))};
  var sign = ${Math.sign(Math.round(clicks)) || 1};
  for (var i = 0; i < n; i++) {
    var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, sign * 3);
    $.CGEventPostToPid(pid, ev);
  }
  'OK ' + pid;
}
`;
  try {
    const out = (await osascriptJxa(script, 8000)).trim();
    if (out.includes('ERR nopoint')) return { ok: false, error: '坐标处未命中窗口' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 文本:逐字符 keydown/keyup + CGEventKeyboardSetUnicodeString 挂 Unicode。
async function bgTypeMac(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!bgLastClickPid) return { ok: false, error: '后台键盘尚未锁定目标窗口:先 mouse_click 一次(后台模式点击不占焦点)' };
  // 文本经 base64 进 JXA,规避 shell 引号转义
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var pid = ${bgLastClickPid};
var str = ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSData.alloc.initWithBase64EncodedStringOptions('${b64}', 0), $.NSUTF8StringEncoding));
if (str === null || str === undefined) { 'ERR b64' } else {
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ch === '\\n') ch = '\\r';
    var d = $.CGEventCreateKeyboardEvent($(), 0, true);
    $.CGEventKeyboardSetUnicodeString(d, ch.length, ch);
    $.CGEventPostToPid(pid, d);
    var u = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(u, ch.length, ch);
    $.CGEventPostToPid(pid, u);
  }
  'OK';
}
`;
  try {
    const out = (await osascriptJxa(script, Math.min(30000, 5000 + text.length * 20))).trim();
    if (out.includes('ERR b64')) return { ok: false, error: '文本解码失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 按键/组合键:macOS virtual key codes(美式布局)+ CGEventSetFlags。
const BG_MAC_VK: Record<string, { vk: number; flag?: string }> = {
  enter: { vk: 36 }, return: { vk: 36 }, tab: { vk: 48 }, escape: { vk: 53 }, esc: { vk: 53 },
  backspace: { vk: 51 }, delete: { vk: 117 }, del: { vk: 117 },
  home: { vk: 115 }, end: { vk: 119 }, pageup: { vk: 116 }, pagedown: { vk: 121 },
  arrowup: { vk: 126 }, arrowdown: { vk: 125 }, arrowleft: { vk: 123 }, arrowright: { vk: 124 },
  space: { vk: 49 },
  ctrl: { vk: 59, flag: '$.kCGEventFlagMaskControl' }, control: { vk: 59, flag: '$.kCGEventFlagMaskControl' },
  shift: { vk: 56, flag: '$.kCGEventFlagMaskShift' },
  alt: { vk: 58, flag: '$.kCGEventFlagMaskAlternate' },
};

// 上面字母 vk 表不易读,显式重写(展开顺序以后写的为准):
Object.assign(BG_MAC_VK, {
  a: { vk: 0 }, s: { vk: 1 }, d: { vk: 2 }, f: { vk: 3 }, h: { vk: 4 }, g: { vk: 5 }, z: { vk: 6 },
  x: { vk: 7 }, c: { vk: 8 }, v: { vk: 9 }, b: { vk: 11 }, q: { vk: 12 }, w: { vk: 13 }, e: { vk: 14 },
  r: { vk: 15 }, y: { vk: 16 }, t: { vk: 17 }, u: { vk: 32 }, i: { vk: 34 }, o: { vk: 31 }, p: { vk: 35 },
  l: { vk: 37 }, j: { vk: 38 }, k: { vk: 40 }, n: { vk: 45 }, m: { vk: 46 },
  '1': { vk: 18 }, '2': { vk: 19 }, '3': { vk: 20 }, '4': { vk: 21 }, '5': { vk: 23 },
  '6': { vk: 22 }, '7': { vk: 26 }, '8': { vk: 28 }, '9': { vk: 25 }, '0': { vk: 29 },
});

async function bgKeyMac(key: string): Promise<{ ok: boolean; error?: string }> {
  if (!bgLastClickPid) return { ok: false, error: '后台键盘尚未锁定目标窗口:先 mouse_click 一次(后台模式点击不占焦点)' };
  const parts = key.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = parts.filter((p) => ['ctrl', 'control', 'shift', 'alt', 'cmd', 'command', 'meta'].includes(p));
  const finalPart = parts.filter((p) => !mods.includes(p)).pop() ?? '';
  const finalDef = BG_MAC_VK[finalPart];
  const modDefs = mods.map((m) => BG_MAC_VK[m] ?? (m === 'cmd' || m === 'command' || m === 'meta' ? { vk: 55, flag: '$.kCGEventFlagMaskCommand' } : null)).filter(Boolean) as Array<{ vk: number; flag?: string }>;
  if (!finalDef) return { ok: false, error: `后台模式不支持的按键: ${key}(字母/数字/Enter/方向键等组合可用;其余请关后台模式)` };
  // 组合键 flags:修饰键 flag 位或;单键无 flags
  const flagBits = modDefs.map((d) => d.flag ?? '$.kCGEventFlagMaskControl').join(' | ');
  const setFlags = mods.length ? '$.CGEventSetFlags(ev, ' + (flagBits || '0') + ');' : '';
  const script = `
ObjC.import('CoreGraphics');
var pid = ${bgLastClickPid};
function tap(vk) {
  var d = $.CGEventCreateKeyboardEvent($(), vk, true);
  var u = $.CGEventCreateKeyboardEvent($(), vk, false);
  ${setFlags.replace(/ev/g, 'd')}
  ${setFlags.replace(/ev/g, 'u')}
  $.CGEventPostToPid(pid, d);
  $.CGEventPostToPid(pid, u);
}
${modDefs.map((d) => `tap(${d.vk});`).join('\n')}
tap(${finalDef.vk});
'OK';
`;
  try {
    const out = (await osascriptJxa(script, 5000)).trim();
    if (out !== 'OK') return { ok: false, error: out || 'JXA 执行失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 后台拖拽:down → 一串 dragged → up,全部投给命中 pid。
async function bgDragMac(fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: boolean; error?: string }> {
  const steps = 8;
  const pts = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return { x: Math.round(fromX + (toX - fromX) * t), y: Math.round(fromY + (toY - fromY) * t) };
  });
  const script = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var hx = ${Math.round(fromX)}, hy = ${Math.round(fromY)};
${jxaHitTest()}
if (!pid) { 'ERR nopoint' } else {
  var path = ${JSON.stringify(pts)};
  $.CGEventPostToPid(pid, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, path[0], $.kCGMouseButtonLeft));
  for (var i = 1; i < path.length; i++) {
    $.CGEventPostToPid(pid, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, path[i], $.kCGMouseButtonLeft));
  }
  $.CGEventPostToPid(pid, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, path[path.length - 1], $.kCGMouseButtonLeft));
  'OK';
}
`;
  try {
    const out = (await osascriptJxa(script, 8000)).trim();
    if (out.includes('ERR nopoint')) return { ok: false, error: '起点坐标处未命中窗口' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 独立 PS 类型缓存不必 —— 每次调用一次性进程,Add-Type 内联即可。
// 后台点击:WindowFromPoint → 客户区坐标 → WM_* 消息对。返回目标窗口句柄。
// 消息序:单击 down→up;双击 DBLCLK×2(WM_LBUTTONDBLCLK 自带按下语义,CS_DBLCLKS
// 窗口由它合成单击+双击序列)。wParam=MK 标志(down 时含按键按下态)。
async function bgMouseClickWin(x: number, y: number, button: 'left' | 'right' | 'middle', doubleClick: boolean): Promise<{ ok: boolean; error?: string; hwnd?: number }> {
  // WM_LBUTTONDOWN=0x201 UP=0x202 DBLCLK=0x203 | R: 0x204/0x205/0x206 | M: 0x207/0x208/0x209
  const down = button === 'right' ? 0x204 : button === 'middle' ? 0x207 : 0x201;
  const dbl = button === 'left' ? 0x203 : button === 'right' ? 0x206 : 0x209;
  const msgSeq = doubleClick ? [dbl, dbl] : [down, down + 1]; // down→up / DBLCLK×2
  const mk = doubleClick ? 0 : button === 'right' ? 0x2 : button === 'middle' ? 0x10 : 0x1; // MK_RBUTTON/MK_MBUTTON/MK_LBUTTON(down 时);DBLCLK 由目标合成,给 0 即可
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BgMouse {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$p = New-Object BgMouse+POINT
$p.X = ${Math.round(x)}; $p.Y = ${Math.round(y)}
$h = [BgMouse]::WindowFromPoint($p)
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR nopoint'; exit 0 }
[BgMouse]::ScreenToClient($h, [ref]$p)
$lp = (($p.Y -shl 16) -bor ($p.X -band 0xFFFF))
${msgSeq.map((f) => `[BgMouse]::PostMessage($h, ${f}, ${mk}, $lp) | Out-Null\nStart-Sleep -Milliseconds 12`).join('\n')}
Write-Output "OK $([long]$h)"
`.trim();
  try {
    const out = await runShellCapture(ps, 5000);
    const m = /OK (\d+)/.exec(out);
    if (out.includes('ERR nopoint') || !m) return { ok: false, error: '坐标处未命中窗口(可能在屏幕外)' };
    const hwnd = Number(m[1]);
    bgLastClickHwnd = hwnd;
    return { ok: true, hwnd };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 后台滚轮:WM_MOUSEWHEEL(0x20A)。注意 wParam 高16位 delta、低16位修饰键,而
// lParam 是"屏幕坐标"(与 WM_LBUTTON* 的客户区坐标不同 —— Win32 老坑)。
async function bgMouseScrollWin(x: number, y: number, clicks: number): Promise<{ ok: boolean; error?: string }> {
  const lp = (Math.round(y) << 16) | (Math.round(x) & 0xFFFF); // WM_MOUSEWHEEL lParam = 屏幕坐标(与点击消息的客户区坐标不同,Win32 老坑)
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BgWheel {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$p = New-Object BgWheel+POINT
$p.X = ${Math.round(x)}; $p.Y = ${Math.round(y)}
$h = [BgWheel]::WindowFromPoint($p)
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR nopoint'; exit 0 }
$notch = [Math]::Sign(${Math.round(clicks)}) * 120
$loops = [Math]::Max(1, [Math]::Min(30, [Math]::Abs(${Math.round(clicks)})))
for ($i = 0; $i -lt $loops; $i++) {
  [BgWheel]::PostMessage($h, 0x20A, ($notch -shl 16), $lp) | Out-Null
  Start-Sleep -Milliseconds 12
}
Write-Output "OK $([long]$h)"
`.trim();
  try {
    const out = await runShellCapture(ps, 8000);
    if (out.includes('ERR nopoint')) return { ok: false, error: '坐标处未命中窗口' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 后台键盘宿主解析:键盘消息投给 lastClickHwnd;IsWindow 过滤已销毁句柄。
// 失败(从未点过/窗口已关)返回 null → 调用方回落前台方式并提示。
function bgKeyboardHwnd(): number | null {
  return bgLastClickHwnd;
}

// 后台拖拽:down@起点 → 中途插值移动若干 WM_MOUSEMOVE → up@终点(客户区坐标)。
async function bgDragWin(fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: boolean; error?: string }> {
  const steps = 8; // 插值步数:给目标窗口的拖拽检测(命中测试/选择更新)留出处理节拍
  const toClient = (hx: number, hy: number) => `((${Math.round(hy)} -shl 16) -bor (${Math.round(hx)} -band 0xFFFF))`;
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BgDrag {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$p = New-Object BgDrag+POINT
$p.X = ${Math.round(fromX)}; $p.Y = ${Math.round(fromY)}
$h = [BgDrag]::WindowFromPoint($p)
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR nopoint'; exit 0 }
[BgDrag]::ScreenToClient($h, [ref]$p)
$lp0 = (($p.Y -shl 16) -bor ($p.X -band 0xFFFF))
[BgDrag]::PostMessage($h, 0x201, 1, $lp0) | Out-Null
Start-Sleep -Milliseconds 60
$pts = @(
${Array.from({ length: steps - 1 }, (_, i) => {
    const t = (i + 1) / steps;
    const ix = Math.round(fromX + (toX - fromX) * t);
    const iy = Math.round(fromY + (toY - fromY) * t);
    return `  @{X=${ix};Y=${iy}}`;
  }).join('\n')}
)
foreach ($pt in $pts) {
  $q = New-Object BgDrag+POINT
  $q.X = $pt.X; $q.Y = $pt.Y
  [BgDrag]::ScreenToClient($h, [ref]$q)
  $lpn = (($q.Y -shl 16) -bor ($q.X -band 0xFFFF))
  [BgDrag]::PostMessage($h, 0x200, 1, $lpn) | Out-Null
  Start-Sleep -Milliseconds 25
}
[BgDrag]::PostMessage($h, 0x202, 0, $lpn) | Out-Null
Start-Sleep -Milliseconds 30
Write-Output "OK $([long]$h)"
`.trim();
  void toClient;
  try {
    const out = await runShellCapture(ps, 8000);
    if (out.includes('ERR nopoint')) return { ok: false, error: '起点坐标处未命中窗口' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 文本输入:WM_CHAR 逐字符投递(\n→\r)。文本走 base64 进 PS,规避引号转义双地狱。
// 注意:WM_CHAR 对标准编辑控件/Chromium 文本框有效;个别自绘输入框只认 KEYDOWN
// 序列的会收不到 —— 属已知边界,前台模式兜底。
async function bgKeyboardTypeWin(text: string): Promise<{ ok: boolean; error?: string }> {
  const hwnd = bgKeyboardHwnd();
  if (!hwnd) return { ok: false, error: '后台键盘尚未锁定目标窗口:先 mouse_click 一次(后台模式点击不占焦点)' };
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BgKeys {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@
$h = [IntPtr]::${hwnd}
if (-not [BgKeys]::IsWindow($h)) { Write-Output 'ERR dead'; exit 0 }
$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$WM_CHAR = 0x102
foreach ($ch in $s.ToCharArray()) {
  $code = [int]$ch
  if ($code -eq 10) { $code = 13 }
  [BgKeys]::PostMessage($h, $WM_CHAR, [IntPtr]$code, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 6
}
Write-Output 'OK'
`.trim();
  try {
    const out = await runShellCapture(ps, Math.min(20000, 5000 + text.length * 15));
    if (out.includes('ERR dead')) return { ok: false, error: '目标窗口已关闭,请重新 mouse_click 锁定' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 按键/组合键:VK 码 WM_KEYDOWN/KEYUP + 控制键扫描码;组合 = 修饰键 down → 主键 → 修饰键 up。
// Alt 走 WM_SYSKEYDOWN/UP(普通 KEYDOWN 大多数 App 不当 Alt 处理)。可打印主键补发 WM_CHAR。
const BG_VK: Record<string, { vk: number; scan: number; sys?: boolean }> = {
  enter: { vk: 0x0D, scan: 0x1C }, tab: { vk: 0x09, scan: 0x0F }, escape: { vk: 0x1B, scan: 0x01 },
  esc: { vk: 0x1B, scan: 0x01 }, backspace: { vk: 0x08, scan: 0x0E }, delete: { vk: 0x2E, scan: 0x53 },
  del: { vk: 0x2E, scan: 0x53 }, home: { vk: 0x24, scan: 0x47 }, end: { vk: 0x23, scan: 0x4F },
  pageup: { vk: 0x21, scan: 0x49 }, pagedown: { vk: 0x22, scan: 0x51 },
  arrowup: { vk: 0x26, scan: 0x48 }, arrowdown: { vk: 0x28, scan: 0x50 },
  arrowleft: { vk: 0x25, scan: 0x4B }, arrowright: { vk: 0x27, scan: 0x4D },
  space: { vk: 0x20, scan: 0x39 }, ctrl: { vk: 0x11, scan: 0x1D }, control: { vk: 0x11, scan: 0x1D },
  shift: { vk: 0x10, scan: 0x2A }, alt: { vk: 0x12, scan: 0x38, sys: true },
};

function bgKeyLParam(scan: number, up: boolean): number {
  // lParam: bits16-23 扫描码;bit30(extended 略)bit31=释放;KEYDOWN 位24 extended=0 即可
  return up ? (0xC0000000 | ((scan & 0xFF) << 16)) >>> 0 : ((scan & 0xFF) << 16);
}

async function bgKeyboardKeyWin(key: string): Promise<{ ok: boolean; error?: string }> {
  const hwnd = bgKeyboardHwnd();
  if (!hwnd) return { ok: false, error: '后台键盘尚未锁定目标窗口:先 mouse_click 一次(后台模式点击不占焦点)' };
  // 解析 "Ctrl+Shift+Tab" 形式
  const parts = key.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = parts.filter((p) => ['ctrl', 'control', 'shift', 'alt'].includes(p));
  const finalPart = parts.filter((p) => !['ctrl', 'control', 'shift', 'alt'].includes(p)).pop() ?? '';
  const modDefs = mods.map((m) => BG_VK[m]).filter(Boolean);
  const finalDef = BG_VK[finalPart];
  // 可打印字符主键:单字符直接 WM_CHAR;多字符未知名 → 报错(不猜)
  const printable = !finalDef && finalPart.length === 1 ? finalPart : null;
  if (!finalDef && !printable) return { ok: false, error: `后台模式不支持的按键: ${key}(可打印单字符与 Enter/Tab/方向键等组合可用;其余请关后台模式)` };
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BgKeys2 {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@
$h = [IntPtr]::${hwnd}
if (-not [BgKeys2]::IsWindow($h)) { Write-Output 'ERR dead'; exit 0 }
$WM_KEYDOWN = 0x100; $WM_KEYUP = 0x101; $WM_SYSKEYDOWN = 0x104; $WM_SYSKEYUP = 0x105; $WM_CHAR = 0x102
${modDefs.map((d) => `[BgKeys2]::PostMessage($h, ${d.sys ? '$WM_SYSKEYDOWN' : '$WM_KEYDOWN'}, [IntPtr]${d.vk}, [IntPtr]${bgKeyLParam(d.scan, false)}) | Out-Null\nStart-Sleep -Milliseconds 10`).join('\n')}
Start-Sleep -Milliseconds 20
${finalDef ? `[BgKeys2]::PostMessage($h, ${finalDef.sys ? '$WM_SYSKEYDOWN' : '$WM_KEYDOWN'}, [IntPtr]${finalDef.vk}, [IntPtr]${bgKeyLParam(finalDef.scan, false)}) | Out-Null
Start-Sleep -Milliseconds 20
[BgKeys2]::PostMessage($h, ${finalDef.sys ? '$WM_SYSKEYUP' : '$WM_KEYUP'}, [IntPtr]${finalDef.vk}, [IntPtr]${bgKeyLParam(finalDef.scan, true)}) | Out-Null` : `[BgKeys2]::PostMessage($h, $WM_KEYDOWN, [IntPtr]${printable!.charCodeAt(0)}, [IntPtr]0) | Out-Null
[BgKeys2]::PostMessage($h, $WM_CHAR, [IntPtr]${printable!.charCodeAt(0)}, [IntPtr]0) | Out-Null
Start-Sleep -Milliseconds 10
[BgKeys2]::PostMessage($h, $WM_KEYUP, [IntPtr]${printable!.charCodeAt(0)}, [IntPtr]0xC0000000) | Out-Null`}
Start-Sleep -Milliseconds 20
${modDefs.slice().reverse().map((d) => `[BgKeys2]::PostMessage($h, ${d.sys ? '$WM_SYSKEYUP' : '$WM_KEYUP'}, [IntPtr]${d.vk}, [IntPtr]${bgKeyLParam(d.scan, true)}) | Out-Null\nStart-Sleep -Milliseconds 10`).join('\n')}
Write-Output 'OK'
`.trim();
  try {
    const out = await runShellCapture(ps, 5000);
    if (out.includes('ERR dead')) return { ok: false, error: '目标窗口已关闭,请重新 mouse_click 锁定' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Helpers ──
function runShell(cmd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const isPs = process.platform === 'win32';
    const child = exec(
      cmd,
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        shell: isPs ? 'powershell.exe' : undefined,
        maxBuffer: 1024 * 1024,
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    // Prevent unhandled 'error' event
    child.on('error', () => reject(new Error('Failed to spawn shell')));
  });
}

// 带 stdout 捕获的执行(后台模式需要从 PS 拿窗口句柄/错误标记)。
// / Shell runner that captures stdout (background mode reads the hwnd back).
function runShellCapture(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(
      cmd,
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err && !stdout) reject(err);
        else resolve(String(stdout ?? ''));
      },
    );
    child.on('error', () => reject(new Error('Failed to spawn shell')));
  });
}

function shellEscape(s: string): string {
  // Basic shell escaping for macOS/Linux
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
