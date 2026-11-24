// 内置高危规则回归(2026-11-24)
// 背景:会话 b580efbe 2026-11-23 14:49 —— agent 想清 en-US 里 FAILED 的 appPreview,
// 脚本写成「遍历整个集合逐个 DELETE」,两条都 204 成功,把线上唯一能用的原版一起删了,
// 随后花 7 小时重造一个本地早就有的文件(~/Documents/kinet/artifacts/kb_preview_video/
// kinetbrief_preview_v2_bgm.mp4,10-16 就躺在那里)。
// 语义判断机器做不对,能机械做的只有:删之前强制让人看一眼。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkAgentPolicy } from '../../src/main/agent-policy';

// 空目录 = 没有 agent.policy.json,验证内置规则不依赖策略文件
const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-policy-'));

// 事故当天的真实命令(节选,heredoc 原文)
const INCIDENT = `cd "/Users/phinn/.openclaw-autoclaw/agents/km/workspace/Products/KinetBrief" && python3 - <<'EOF'
import sys
sys.path.insert(0, "scripts")
import asc
# 清掉 en-US 失败的 preview (FAILED 态可直接 DELETE)
st, b = asc.call("GET", "/v1/appPreviewSets/79869eee/appPreviews")
for d in b.get("data", []):
    r = asc.call("DELETE", f"/v1/appPreviews/{d['id']}")
    print("delete", d["id"], r)
EOF`;

test('事故命令(遍历集合逐个 DELETE appPreviews)→ ask,不再静默执行', () => {
  const v = checkAgentPolicy(INCIDENT, emptyCwd);
  assert.equal(v.action, 'ask', `应强制确认,实际 ${v.action}`);
  assert.ok(String(v.reason).includes('不可逆'), `理由要讲清不可逆:${v.reason}`);
});

test('批量删:for 循环里发 DELETE(哪怕目标不是 ASC)→ ask', () => {
  const cmd = `for id in $(cat ids.txt); do curl -X DELETE "https://api.example.com/items/$id"; done`;
  assert.equal(checkAgentPolicy(cmd, emptyCwd).action, 'ask');
});

test('单个 DELETE 且目标明确 → 不拦截(避免把正常返工流程卡死)', () => {
  const cmd = `curl -X DELETE "https://api.example.com/items/123"`;
  assert.equal(checkAgentPolicy(cmd, emptyCwd).action, 'none');
});

test('不误伤:读列表 / 上传 / GET 一律 none', () => {
  for (const cmd of [
    `curl "https://api.appstoreconnect.apple.com/v1/appPreviews"`,
    `python3 scripts/asc_upload_199_promos.py en`,
    `grep -rn "DELETE" scripts/`,
    `git commit -m "remove DELETE call"`,
  ]) {
    assert.equal(checkAgentPolicy(cmd, emptyCwd).action, 'none', `不该拦:${cmd}`);
  }
});

test('文件策略的 deny 仍然优先于内置 ask', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-policy2-'));
  fs.writeFileSync(path.join(cwd, 'agent.policy.json'), JSON.stringify({
    version: 1,
    deny: [{ pattern: 'appPreviews', reason: '这个仓库禁止碰 appPreviews' }],
  }));
  const v = checkAgentPolicy(INCIDENT, cwd);
  assert.equal(v.action, 'deny', 'deny 应压过内置 ask');
  assert.ok(String(v.reason).includes('禁止碰'), `应回显用户自己的理由:${v.reason}`);
});

run();
