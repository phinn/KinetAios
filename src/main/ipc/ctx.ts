// ⚠️ 本文件由 scripts/split-ipc.mjs 机械生成(main.ts registerIpc 拆分),勿手改;改 main.ts 后重跑生成器
// 域: ctx
import type { BrowserWindow, NativeImage } from 'electron';
import type { TaskManager } from '../TaskManager';
import type { PromptTemplate, Conversation, GitSnapshot, GitDiffResult, GitActionResult, GitActionKind, RuleConfig } from '../../shared/types';
import type { VoiceChat } from '../VoiceChat';
import { nativeImage, Tray } from 'electron';

export interface IpcDeps {
  isBlockedSystemPath(absPath: string): boolean;
  dashboardWin(): BrowserWindow | null;
  taskManager(): TaskManager;
  tray(): Tray | null;
  voiceChatRef(): VoiceChat | null;
  setVoiceChatRef(v: VoiceChat | null): void;
  pendingConfirms: Map<string, (approved: boolean) => void>;
  pendingPrivacyConfirms: Map<string, { fn: (approved: boolean) => void; timer: NodeJS.Timeout }>;
  confirm(cmd: string): Promise<boolean>;
  drainConfirms(): void;
  safeSend(win: BrowserWindow | null, channel: string, data: unknown): void;
  IPC_TURNS_CHAR_LIMIT: number;
  _appIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined;
  set_appIcon(v: ReturnType<typeof nativeImage.createFromPath> | undefined): void;
  _appIconKey(): string | null;
  set_appIconKey(v: string | null): void;
  appIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined;
  toggleMetricsWindow(): void;
  toggleFilesWindow(cwd?: string): void;
  toggleArenaWindow(cwd?: string): void;
  listDirAbs(absPath: string): { ok: boolean; entries?: import('../../shared/types').DirEntry[]; error?: string };
  gitSnapshotAsync(cwd: string): Promise<GitSnapshot>;
  gitDiffAsync(cwd: string, opts: { file?: string; hash?: string; staged?: boolean }): Promise<GitDiffResult>;
  gitActionAsync(cwd: string, action: GitActionKind, opts?: { message?: string; file?: string; branch?: string }): Promise<GitActionResult>;
  makeTrayIcon(): NativeImage;
  showMemoryGraph(): void;
  rebuildTrayMenu(): void;
  buildCollectScript(x1: number, y1: number, x2: number, y2: number): string;
  builtinTemplates(): PromptTemplate[];
  generateRules(cfg: RuleConfig): string;
  exportMarkdown(conv: Conversation): string;
  exportHTML(conv: Conversation, productName: string): string;
  computeLineDiff(leftText: string, rightText: string): string;
}

export const deps: IpcDeps = {} as IpcDeps;
