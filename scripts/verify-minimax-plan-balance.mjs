// 验证 MiniMax 订阅余额链路:①balanceSnapshot 推断(JWT key → minimax-plan + token_plan URL)②collab 解析逻辑(mock 返回体)
import { balanceSnapshot } from '../dist/main/settings.js';

// ① 推断逻辑:不指定 profileId,走当前活跃 profile
const snap = balanceSnapshot(null);
console.log('snapshot.provider =', snap.provider);
console.log('snapshot.url      =', snap.url);
console.log('snapshot.auth     =', snap.authScheme);
console.log('key 形态          =', snap.apiKey ? snap.apiKey.slice(0, 6) + '…(' + snap.apiKey.length + 'ch)' : '(空)');

// ② 解析逻辑:用真机抓包的返回结构喂给与 collab.ts 相同的映射(独立复刻断言)
const mockBody = {
  model_remains: [{
    model_name: 'general',
    remains_time: 14989837,
    current_interval_remaining_percent: 0,
    weekly_remains_time: 83389837,
    current_weekly_remaining_percent: 61,
    weekly_boost_permille: 1500,
    end_time: 1794690000000,
    weekly_end_time: 1794758400000,
  }],
  base_resp: { status_code: 0, status_msg: 'success' },
};
const m = mockBody.model_remains[0];
const tiers = [];
const ivPct = Number(m.current_interval_remaining_percent);
const wkPct = Number(m.current_weekly_remaining_percent);
if (Number.isFinite(ivPct)) tiers.push({ window: '5h', pct: Math.max(0, Math.min(100, 100 - ivPct)), reset: String(m.end_time) });
if (Number.isFinite(wkPct)) tiers.push({ window: 'weekly', pct: Math.max(0, Math.min(100, 100 - wkPct)), reset: String(m.weekly_end_time) });
console.log('parsed tiers =', JSON.stringify(tiers));
// 断言:5h 剩余0% → 已用100%;weekly 剩余61% → 已用39%
const ok = tiers[0]?.pct === 100 && tiers[1]?.pct === 39;
console.log(ok ? '✅ 剩余→已用口径取反正确' : '❌ 口径取反错误');
process.exit(ok ? 0 : 1);
