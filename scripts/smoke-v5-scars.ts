/* 冒烟: GeneRegistry 疤痕持久化(recordScar → 新实例 loadState 回读)。
 * 用法: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <tsx cli> scripts/smoke-v5-scars.ts */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-v5-'));
import { GeneRegistry } from '../src/main/V5/registry';

// 实例 1:记录疤痕 + 造配子
const r1 = new GeneRegistry({ dataDir: dir, rng: () => 0.42 });
const founder = r1.spawnFounder('tplA', 'light');
r1.recordScar(founder.lineage, { cause: 'tool_error', toolName: 'shell' });
const scar1 = r1.scarOf(founder.lineage);
if (!scar1 || scar1.cause !== 'tool_error') throw new Error('实例1 写后读失败');

// 实例 2(模拟 app 重启):疤痕应从 state.json 回读
const r2 = new GeneRegistry({ dataDir: dir });
const scar2 = r2.scarOf(founder.lineage);
if (!scar2) throw new Error('重启后疤痕丢失(旧债务行为)');
if (scar2.cause !== 'tool_error' || scar2.toolName !== 'shell') throw new Error(`疤痕内容不一致: ${JSON.stringify(scar2)}`);

// 无疤痕 lineage 返回 null(走克隆冠军路径的判据)
if (r2.scarOf('L0-nonexistent') !== null) throw new Error('无疤痕应返回 null');

// 覆盖语义:同 lineage 新疤覆盖旧疤
r2.recordScar(founder.lineage, { cause: 'assertion_fail', assertionId: 'a1' });
const r3 = new GeneRegistry({ dataDir: dir });
const scar3 = r3.scarOf(founder.lineage);
if (scar3?.cause !== 'assertion_fail') throw new Error('疤痕覆盖失败');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ v5 scars: 跨实例持久 + 覆盖语义 + 无痕 null OK');
console.log('smoke done');
