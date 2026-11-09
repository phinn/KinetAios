
#!/usr/bin/env python3
"""本地权威校验:JSON Schema(winget-cli v1.28.0) + 跨文件规则(复刻 YamlParser.cpp + winget-pkgs FieldDuplicate 规则)"""
import json, os, re, sys, yaml
from jsonschema import Draft7Validator

DIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/wg_new'
SCHEMA_DIR = '/tmp/wg_schemas128'
FILES = {
    'version':       'KinetAios.KinetAios.yaml',
    'defaultLocale': 'KinetAios.KinetAios.locale.en-US.yaml',
    'installer':     'KinetAios.KinetAios.installer.yaml',
}

def load(p):
    with open(p, encoding='utf-8') as f:
        return yaml.safe_load(f)

print(f'═══ 校验目录: {DIR} (schema v1.28.0) ═══\n')
docs = {}; errs = 0
for mt, fn in FILES.items():
    path = os.path.join(DIR, fn)
    if not os.path.exists(path):
        print(f'✗ {fn} 缺失'); errs += 1; continue
    doc = load(path); docs[mt] = doc
    schema = json.load(open(f'{SCHEMA_DIR}/{mt}.json'))
    found = sorted(Draft7Validator(schema).iter_errors(doc), key=lambda e: list(e.path))
    if found:
        print(f'✗ {fn}  (schema={mt})')
        for e in found:
            print(f"    - {'/'.join(str(x) for x in e.path) or '(root)'}: {e.message}")
        errs += len(found)
    else:
        print(f'✓ {fn}  (schema={mt})')

print()
if len(docs) == 3:
    ver, dl, ins = docs['version'], docs['defaultLocale'], docs['installer']
    print('── 跨文件规则 ──')
    def chk(cond, msg):
        global errs
        if cond: print(f'  ✓ {msg}')
        else: print(f'  ✗ {msg}'); errs += 1

    chk(ver.get('ManifestType') == 'version', 'version 文件 ManifestType=version')
    chk(dl.get('ManifestType') == 'defaultLocale', 'locale.en-US 文件 ManifestType=defaultLocale')
    chk(ins.get('ManifestType') == 'installer', 'installer 文件 ManifestType=installer')
    chk(ver.get('PackageIdentifier') == dl.get('PackageIdentifier') == ins.get('PackageIdentifier'), '三件 PackageIdentifier 一致')
    chk(ver.get('PackageVersion') == dl.get('PackageVersion') == ins.get('PackageVersion'), '三件 PackageVersion 一致')
    chk(ver.get('DefaultLocale') == dl.get('PackageLocale') == 'en-US', f"DefaultLocale({ver.get('DefaultLocale')}) == defaultLocale.PackageLocale({dl.get('PackageLocale')})")
    chk(ver.get('ManifestVersion') == dl.get('ManifestVersion') == ins.get('ManifestVersion') == '1.28.0', f"三件 ManifestVersion=1.28.0: {ver.get('ManifestVersion')}/{dl.get('ManifestVersion')}/{ins.get('ManifestVersion')}")

    # ★ FieldDuplicate:ReleaseDate 只允许出现在 installer(上游惯例)
    rd = {'version': ver.get('ReleaseDate'), 'defaultLocale': dl.get('ReleaseDate'), 'installer': ins.get('ReleaseDate')}
    present = [k for k, v in rd.items() if v is not None]
    chk(len(present) <= 1, f'ReleaseDate 不重复(仅可出现在一个文件) — 出现在: {present} 值={rd}')
    chk('installer' in present, 'ReleaseDate 放在 installer 文件(与上游惯例一致)')

    locale_files = [f for f in os.listdir(DIR) if '.locale.' in f]
    locales = {}
    for f in locale_files:
        d = load(os.path.join(DIR, f))
        locales.setdefault(d.get('PackageLocale'), []).append((f, d.get('ManifestType')))
    chk(not {k: v for k, v in locales.items() if len(v) > 1}, f'locale 唯一 — 实际: {locales}')
    for loc, lst in locales.items():
        chk(all(t == 'defaultLocale' for _, t in lst), f'locale {loc} ManifestType 合法: {lst}')

    ver_bad = set(ver.keys()) & {'PackageLocale','Publisher','PackageName','ShortDescription','Description','Moniker','Tags','License','ReleaseNotes','ReleaseNotesUrl','Author','Copyright','ReleaseDate','PublisherUrl','PublisherSupportUrl','PackageUrl','LicenseUrl'}
    chk(not ver_bad, f'version 文件不含 locale 专属字段 — 多余: {ver_bad or "无"}')

    chk(bool(dl.get('ShortDescription')) and len(dl['ShortDescription']) <= 256, f"ShortDescription({len(dl.get('ShortDescription',''))}字符) ≤256")
    chk(bool(dl.get('Description')) and 3 <= len(dl['Description']) <= 10000, f"Description({len(dl.get('Description',''))}字符) 在 [3,10000]")
    tags = dl.get('Tags') or []
    chk(len(tags) <= 16 and len(set(tags)) == len(tags), f'Tags {len(tags)} 个且唯一')
    chk(bool(re.fullmatch(r'[a-z0-9-]+', dl.get('Moniker',''))), f"Moniker 合法: {dl.get('Moniker')}")

    insts = ins.get('Installers', [])
    chk(len(insts) >= 1, f'installers 数量 = {len(insts)}')
    for i in insts:
        sha = i.get('InstallerSha256') or ''
        chk(len(sha) == 64 and all(c in '0123456789abcdefABCDEF' for c in sha), f'InstallerSha256 64位hex: {sha[:20]}...')
        chk(i.get('InstallerUrl','').startswith('https://'), f"InstallerUrl https: {i.get('InstallerUrl','')[:64]}")
        chk(i.get('Scope') in ('user','machine'), f"Scope: {i.get('Scope')}")
        chk(i.get('Architecture') in ('neutral','x64','x86','arm','arm64'), f"Architecture: {i.get('Architecture')}")
    chk(ins.get('MinimumOSVersion') is not None, f"MinimumOSVersion: {ins.get('MinimumOSVersion')}")
    chk(ins.get('InstallerType') == 'nullsoft', f"InstallerType: {ins.get('InstallerType')}")
    chk(bool((ins.get('InstallerSwitches') or {}).get('Upgrade')), f"Upgrade switch: {(ins.get('InstallerSwitches') or {}).get('Upgrade')}")
    pc = ins.get('ProductCode')
    chk(bool(pc), f'ProductCode 存在: {pc}')
    arp = (ins.get('AppsAndFeaturesEntries') or [{}])[0]
    chk(arp.get('ProductCode') == pc, f"AppsAndFeaturesEntries.ProductCode == ProductCode: {arp.get('ProductCode')}")
else:
    print('✗ 文件不全'); errs += 1

print()
print('═' * 50)
print('结果:', 'ALL PASS ✅' if errs == 0 else f'{errs} 个错误 ❌')
sys.exit(0 if errs == 0 else 1)
