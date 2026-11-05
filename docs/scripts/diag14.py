import subprocess, json, urllib.request, time, datetime

cred = subprocess.run(["git","credential","fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True).stdout
token = ""
for line in cred.splitlines():
    if line.startswith("password="):
        token = line[len("password="):]

def api(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "phinn"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

targets = [
    ("0PandaDEV/awesome-windows", 299),
    ("AMD-DEV-CONTEST/Radeon-hackathon-2026-07", 79),
    ("ai-boost/awesome-harness-engineering", 270),
    ("deepseek-ai/awesome-deepseek-agent", 414),
    ("deepseek-ai/awesome-deepseek-integration", 739),
    ("jaywcjlove/awesome-mac", 2915),
    ("jiji262/awesome-deepseek-harness", 19),
    ("punkpeye/awesome-mcp-clients", 321),
    ("punkpeye/awesome-mcp-servers", 14667),
    ("reorx/awesome-chatgpt-api", 203),
    ("steven2358/awesome-generative-ai", 1400),
    ("e2b-dev/awesome-ai-agents", 1397),
]
since = "2026-10-05"
for repo, num in targets:
    try:
        pr = api(f"https://api.github.com/repos/{repo}/pulls/{num}")
        ms = pr.get("mergeable_state")
        mrg = pr.get("mergeable")
        upd = pr.get("updated_at","")[:10]
        # 近30天仓吞吐
        q = f"https://api.github.com/search/issues?q=repo:{repo}+type:pr+merged:>{since}&per_page=1"
        thr = api(q).get("total_count", "?")
        flag = {"clean":"✅clean","dirty":"❌DIRTY","unstable":"⚠️unstable","blocked":"🚫blocked","unknown":"·"}.get(str(ms), str(ms))
        print(f"{repo}#{num}: {flag} | merged30d={thr} | last_update={upd}")
    except Exception as e:
        print(f"{repo}#{num}: ERR {e}")
    time.sleep(0.5)
