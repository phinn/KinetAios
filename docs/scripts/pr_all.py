import subprocess, json, urllib.request, time

cred = subprocess.run(["git","credential","fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True).stdout
token = ""
for line in cred.splitlines():
    if line.startswith("password="):
        token = line[len("password="):]

def api(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "phinn"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

prs = []
page = 1
while True:
    d = api(f"https://api.github.com/search/issues?q=author:phinn+type:pr&per_page=100&page={page}&sort=created&order=desc")
    items = d.get("items", [])
    prs.extend(items)
    if len(items) < 100 or page >= 5:
        break
    page += 1
    time.sleep(1)

print("total search count:", d.get("total_count"), "| fetched:", len(prs))
from collections import defaultdict
by_repo = defaultdict(list)
for it in prs:
    repo = it["repository_url"].split("repos/")[-1]
    pr = it.get("pull_request", {})
    by_repo[repo].append({
        "n": it["number"],
        "title": it["title"][:60],
        "state": it["state"],
        "merged": pr.get("merged_at"),
        "created": it["created_at"][:10],
    })

for repo in sorted(by_repo):
    print(f"\n=== {repo} ({len(by_repo[repo])}) ===")
    for p in by_repo[repo]:
        flag = "MERGED" if p["merged"] else ("open" if p["state"]=="open" else "closed")
        print(f'  #{p["n"]:>6} [{flag:>7}] {p["created"]} {p["title"]}')
