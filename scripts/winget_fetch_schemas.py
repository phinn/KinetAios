#!/usr/bin/env python3
"""拉取 winget-cli 官方 JSON Schema 到本地(winget-cli 的 schemas/JSON/manifests/vX/)"""
import base64, json, os, sys, urllib.request

REPO = 'microsoft/winget-cli'
VER = sys.argv[1] if len(sys.argv) > 1 else '1.28.0'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'winget-schemas', f'v{VER}')
os.makedirs(OUT, exist_ok=True)

for name in ['version', 'defaultLocale', 'installer', 'locale']:
    path = f'schemas/JSON/manifests/v{VER}/manifest.{name}.{VER}.json'
    url = f'https://api.github.com/repos/{REPO}/contents/{path}'
    try:
        req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode())
        open(os.path.join(OUT, f'{name}.json'), 'w').write(base64.b64decode(d['content']).decode())
        print('OK  ', name)
    except Exception as e:
        print('FAIL', name, e)
print('saved to', OUT)
