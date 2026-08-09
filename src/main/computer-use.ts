// Computer Use: screenshot + mouse + keyboard via OS-native APIs.
// No external native deps — uses Electron desktopCapturer for screenshots,
// PowerShell System.Windows.Forms on Windows, cliclick on macOS.
// 计算机使用:截屏 + 鼠标 + 键盘,无原生依赖。
// Screenshots: Electron desktopCapturer (main process).
// Mouse/Keyboard: PowerShell (Windows) / cliclick (macOS) / xdotool (Linux).
import { desktopCapturer, screen as electronScreen } from 'electron';
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
export async function mouseMove(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
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
export async function mouseDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: boolean; error?: string }> {
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

function shellEscape(s: string): string {
  // Basic shell escaping for macOS/Linux
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
