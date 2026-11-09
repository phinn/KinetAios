# WinGet Manifest 编写指南(KinetAios 实测沉淀)

> 来源:2026-11-09 PR `microsoft/winget-pkgs#475205` 校验失败的完整定位过程。
> 所有结论均有**上游源码 / 上游已合入实例 / 本地 schema 校验**三重证据。

## 一、三件套的 ManifestType ↔ 文件名绑定(写错必挂)

| 文件 | ManifestType | 允许内容 |
| --- | --- | --- |
| `<Id>.yaml` | `version` | 仅 `PackageIdentifier` / `PackageVersion` / `DefaultLocale` |
| `<Id>.locale.<xx>.yaml`(默认语言) | `defaultLocale` | 全部元数据:Description / ShortDescription / Moniker / Tags / ReleaseNotes / License … |
| `<Id>.locale.<其它>.yaml` | `locale` | 非默认语言元数据(可选) |
| `<Id>.installer.yaml` | `installer` | 安装器信息 |

- `defaultLocale` 与 `locale` 是**两个概念**。默认语言文件住 `<Id>.locale.en-US.yaml` 且写 `ManifestType: defaultLocale`。
- 再单独提交一个 `ManifestType: locale` 且 `PackageLocale` 同为 `en-US` → 触发 `No duplicate locales across manifests`(`YamlParser.cpp`)。
- 三件 ManifestType 写反 → `IncompleteMultiFileManifest`,bot 报 "Filename mismatch"。

## 二、ManifestVersion 决定用哪版规则

- PR template 明确要求 **1.28 schema**;上游 2026-11-09 当天合并的新包全部使用 `ManifestVersion: 1.28.0`。
- 升到 1.28.0 后 schema URL 同步改:`https://aka.ms/winget-manifest.<type>.1.28.0.schema.json`。

## 三、ProductCode 不能想当然摘掉

NSIS 的 ARP 注册码由 electron-builder 派生:

```
UUID.v5(appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"))
```

本地直接算(项目自带依赖):

```bash
node -e "const {UUID}=require('builder-util-runtime');\
  console.log(UUID.v5('com.kinet.kinetaios', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')))"
# → f65d9359-0830-527e-8b7c-f7153f15e828
```

appId 不变 → 各版本 GUID 相同。该值同时填 `ProductCode` 与 `AppsAndFeaturesEntries[].ProductCode`。

> 注意:安装器 exe 里能扫到的 GUID 是 NSIS/Electron 内部 GUID(全 v4),**不是** ARP 注册码;ARP 码在压缩的 NSIS 脚本里,扫不出来,只能靠上面的推导或已通过的旧 manifest。

## 四、最贵的坑:修 PR 时删 PR 分支上的旧文件

删掉 PR 分支上的旧文件 → diff 清零 → bot 自动关闭 PR。

真实案例:旧 PR #463867 在 2026-10-28 10:47 已 `Azure-Pipeline-Passed`,2026-11-09 为了换版本删了 4.0.3 目录 → `Unexpected-File` → 03:32 PR 被关闭,白干。

**规则**:修 PR 只改文件内容、不删文件;要换版本就在 PR 分支**新增**版本目录。

## 五、本地验证(macOS 无 winget)

官方推荐 `winget validate <path>`,macOS 没有 winget,替代方案:

1. 拉 `microsoft/winget-cli` 的 `schemas/JSON/manifests/v1.28.0/manifest.{version,defaultLocale,installer}.1.28.0.json`
2. `pip install jsonschema` 本地校验
3. 再复刻跨文件规则:
   - 三件 `PackageIdentifier` / `PackageVersion` 一致
   - `DefaultLocale` == defaultLocale 文件的 `PackageLocale`
   - locale 唯一(无重复 `PackageLocale`)
   - version 文件不含任何 locale 专属字段
   - `ProductCode` == `AppsAndFeaturesEntries[].ProductCode`

## 六、取证路径速查

| 目的 | 手段 |
| --- | --- |
| 真实跨文件规则 | `microsoft/winget-cli` 源码 `src/AppInstallerCommonCore/Manifest/YamlParser.cpp` |
| 真实目录结构范例 | `microsoft/winget-pkgs` 上游已合入包的目录(如 `manifests/m/Microsoft/WindowsTerminal/1.9.1942.0/`) |
| 官方诊断文档(4.3 万字) | `microsoft/winget-pkgs` `.github/workflows/manifest-validation-diagnosis.md` + `doc/manifest/schema/1.28.0/*.md` |
| 动态验证流水线日志 | Azure DevOps `dev.azure.com/shine-oss/winget-pkgs/_apis/build/builds`(curl 可用);GitHub Actions job logs 对外部账号 403 |
| 上游包检索 | `contents` API / GitHub code search(注意:winget-pkgs 的 code search 索引可能失效) |
| raw.githubusercontent.com | 本机被代理黑洞,拉文件改走 `api.github.com` 的 blobs API |

## 七、本项目当前状态

- PR:`github.com/microsoft/winget-pkgs/pull/475205`(KinetAios.KinetAios 4.2.0)
- fork:`phinn/winget-pkgs`,分支 `master`,目录 `manifests/k/KinetAios/KinetAios/4.2.0/`
- 安装器:`https://github.com/phinn/KinetAios/releases/download/v4.2.0/KinetAios.Setup.4.2.0.exe`
  - 大小 87,533,113 bytes
  - SHA-256 `F0DAACB8980B5857C4C4ED5EC240110318FE01D680AE5D395DBCDB2CBE50DC30`(实算校验通过)
