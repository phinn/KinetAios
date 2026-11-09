#!/usr/bin/env python3
# winget PR 周检快照:merge 状态 + 验证标签 + 最新 bot 评论 + 判定提示
# Weekly snapshot for the winget PR: merge state + validation labels + latest bot comments + verdict.
# 用法 / usage: python3 scripts/winget_pr_snapshot.py [PR号, 默认 475205]
import json, subprocess, sys, urllib.request
from datetime import datetime, timezone

PR = sys.argv[1] if len(sys.argv) > 1 else '475205'
T = subprocess.run(['git', 'credential', 'fill'],
                   input='protocol=https\nhost=github.com\n\n',
                   capture_output=True, text=True, timeout=30).stdout
T = [l.split('=', 1)[1] for l in T.splitlines() if l.startswith('password=')][0]


def api(url):
    req = urllib.request.Request(url)
    req.add_header('Authorization', f'token {T}')
    req.add_header('Accept', 'application/vnd.github+json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'__err': e.code}


base = 'https://api.github.com/repos/microsoft/winget-pkgs'
pr = api(base + '/pulls/' + PR)
sha = pr.get('head', {}).get('sha', '?')
print('[now: %s]' % datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'))
print('PR state: %s | merged: %s | merged_at: %s' % (pr.get('state'), pr.get('merged'), pr.get('merged_at')))
print('mergeable_state: %s | head: %s' % (pr.get('mergeable_state'), sha[:12]))
print('labels: %s' % [l['name'] for l in pr.get('labels', [])])

cs = api(base + '/issues/%s/comments?per_page=100' % PR)
if isinstance(cs, list):
    for c in cs[-3:]:
        print('--- %s %s' % (c['user']['login'], c['created_at']))
        print((c.get('body') or '')[:500])

labels = [l['name'] for l in pr.get('labels', [])]
if pr.get('merged'):
    print('VERDICT: MERGED -> 记录 docs/upstream-pr-tracking.md + 删除 cron_winget_475205')
elif pr.get('state') == 'closed':
    print('VERDICT: CLOSED_UNMERGED -> 读 bot 评论定位原因,汇报')
elif 'Azure-Pipeline-Passed' in labels and 'Validation-Completed' in labels:
    print('VERDICT: PASSED_WAITING_MODERATOR -> 仅剩人审闸门,静默等待,不动作')
else:
    print('VERDICT: VALIDATION_ISSUE -> 对照 scripts/winget_manifest_validate.py 修 manifest 后 Contents API 带 sha 重传')
