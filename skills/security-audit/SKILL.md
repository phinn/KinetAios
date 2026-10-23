---
name: security-audit
description: 安全审计工作法（源自 Cloudflare security-audit-skill，32.6k★）。当任务涉及安全审查/漏洞挖掘/渗透测试/代码审计/攻击面分析，或用户要求 audit、安全评估、信任边界分析时使用。方法：信任边界优先、覆盖台账驱动狩猎、独立验证裁决、最小有效修复。约束：只确认已证实的边界失败、验证者不得是发现者、严重度必须绑定真实影响、纵深防御缺失只是加固建议不是漏洞。
---

# 🛡️ 安全审计工作法

方法论源自 [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)（MIT，Cloudflare 漏洞发现 harness 的种子技能）。
本文件是中文执行纪律摘要；**领域细节、攻击类清单、阶段操作规程以 `files/` 目录下的上游原文为单一事实源**（英文，已随本 skill 打包）。

## 0. 两种模式（先判断再动手）

- **指导模式（默认）**：安全提问 / 聚焦 review / 单点调查 → 只取用相关章节，**不要**自动跑全流程、建输出目录、写审计产物。
- **完整审计模式**：用户明确要求 audit / pen-test / 全面安全审查 / 要报告产物 → 跑全部六个阶段并落盘产物。
- 语义模糊时先问一句，不要猜成全量审计烧预算。

## 1. 核心哲学：只找「跨越真实信任边界」的漏洞

一个候选发现必须回答三个问题，缺一不可：
1. **边界**：哪个信任边界被跨越了？（谁 → 谁，权限/身份/数据流向哪变了）
2. **主体**：具体受影响的 principal + resource 是什么？（说不出具体受害者 = 不是发现）
3. **影响**：攻击者实际获得了什么能力？说不出具体损害，降级处理。

**五条铁律（HUNTING.md 的核心纪律，每个 hunter prompt 都带）**：
- 只确认「已成立的边界失败」——源码可查但缺运行时证据的线索记 `needs_validation` 并写明缺失的确切事实。
- **对抗性验证**：验证某发现的 agent 绝不能是发现它的 agent。
- **严重度绑定影响**：可能性 × 影响，不是「偏离了 checklist」。
- **纵深防御缺口 ≠ 漏洞**：若 A 层已阻断攻击，B 层缺失只是加固建议（hardening note）。
- 单次运行只覆盖约一半漏洞：**多轮运行提升覆盖**，报告必须声明覆盖范围，永不暗示「跑完 = 安全」。

## 2. 六阶段流程（完整审计模式）

```
①RECONNAISSANCE 侦察   —— 摸源码/信任边界/构建路径，建确定性覆盖台账(coverage-ledger.json)
②HUNTING 狩猎波次     —— 按台账单元派 hunter,结构化候选收集(每单元×攻击类,不漏记)
③VALIDATION 候选验证   —— 按指纹去重后,每个候选交【新鲜】验证 agent 独立核查
④STRUCTURED OUTPUT    —— findings.json 落盘,跑 files/validate-findings.cjs 校验
⑤RECORD VERIFICATION  —— 对最终记录再派独立复核(检查记录本身,不读 hunter 的叙述)
⑥REPORT 中立报告      —— REPORT.md / FINDINGS-DETAIL.md / NEEDS-VALIDATION.md,无 live-probe 指令
```

终态只有两种：全产物落盘 + 双校验器通过；或 `run_status: "incomplete"` 记明原因并在报告披露。**禁止中途停**。

### 覆盖台账（Phase ① 的关键产出）
每个覆盖单元 = `surface × boundary × subsystem × attack_class` 四元组，唯一 `coverage_id`。
- 台账**只由 parent 更新**（hunter 只回报，不写共享文件）。
- 单元状态机：`planned → assigned → candidate / covered / deferred / out_of_scope`。
- 台账让预算可数：一个单元 ≈ 一个 agent 任务。预算不足的单元**显式记 `deferred`（原因 budget_cannot_reach）**，不许静默漏掉。
- 上一轮 run 的台账/发现要先读：同源未变的 `confirmed` 才可沿用（走当前验证路径）；源码变过的必须重验；上一轮的 quick/局部覆盖**永不暗示「其余没问题」**。

### 运行档位
- **quick**：小目标/重跑/快看。台账粗化（subsystem 固定为 `profile/quick/all-in-scope-subsystems`），恰好一波 hunter + 一次覆盖批评，验证双阶段合并为每个候选一次新鲜复核。
- **standard**（默认）：按流程原文。
- **deep**：高价值/大目标。单元按子系统×生命周期再拆，批评波次跑到干净通过，候选验证与终验保持独立两个 agent。
- **scoped**：只审计子集（指定路径/单子系统/两个 ref 之间的 diff）。范围外记 `out_of_scope`（不是 `covered`），报告必须自称部分覆盖。

## 3. 执行安全（两种模式都适用）

- **源码检查只读**。跑目标控制的构建/测试/进程/浏览器/模糊器，必须进 OS 强制沙箱：无外网、白名单环境变量、目标只读 + 只能写自己的 `scratch/`、显式 CPU/内存/进程/磁盘/时钟上限。
- **沙箱能力不齐就别执行目标代码**：该线索保持 `needs_validation`，写明缺失的沙箱能力 + 安全验证计划。
- 用 dummy 主体/夹具/密钥。**禁止**：探测线上端点/生产身份/他人数据、对共享进程测可用性、发布产物、花付费 API 配额、超出「证明缺陷所需的最小本地效果」。
- 写隔离：每个 agent 独立 `<agent-id>/scratch/`，共享产物只能由 parent 侧可信代码按白名单+大小上限逐个晋升到 `artifacts/`（防 symlink/FIFO/越界写）。禁止拿 /tmp 或家目录当可写回退。

## 4. 攻击类选择（按目标类型从 files/ 取对应章节）

按 Phase ① 的结果挑相关攻击类，不是每类都适用。每类一个 hunter，prompt 里带该文件的核心纪律段：

| 目标类型 | 读哪份 |
|---|---|
| Web/API/认证会话（HTTP 解析、JWT/OAuth/会话/恢复流程） | `files/WEB-PROTOCOL-AND-AUTH.md` |
| RPC/消息（gRPC/GraphQL/Protobuf/队列/事件总线） | `files/PROTOCOLS-RPC-AND-MESSAGING.md` |
| **桌面/移动/本地 IPC（Electron/webview 桥/特权 helper/深链/更新器）** | `files/DESKTOP-MOBILE-AND-LOCAL-IPC.md` |
| AI/LLM/Agent（prompt 注入/RAG/工具调用/MCP/记忆投毒/行动绑定） | `files/AI-AND-LLM.md` |
| 数据隔离与生命周期（租户隔离/软删/恢复/二级使用） | `files/DATA-ISOLATION-AND-LIFECYCLE.md` |
| 供应链与发布（CI 权限/缓存信任混合/构建到晋升替换） | `files/SUPPLY-CHAIN-AND-RELEASE.md` |
| 内存安全与二进制（解析器安全/协议歧义） | `files/MEMORY-SAFETY-AND-BINARY.md` |
| 资源耗尽与可用性 | `files/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` |
| 客户端（浏览器/XSS/CSRF/后量子） | `files/CLIENT-SIDE.md` |
| 云与部署（IAM/SSRF/容器逃逸） | `files/CLOUD-AND-DEPLOYMENT.md` |
| 全类清单 + 通用类（跨组件信任差/二级使用/权限膨胀/时序窗口/回滚） | `files/ATTACK-CLASSES.md` |
| 侦察/台账规程 | `files/RECONNAISSANCE.md` |
| 狩猎波次/hunter prompt 纪律 | `files/HUNTING.md` |
| 验证/结构化输出/报告规程 | `files/VALIDATION-AND-REPORTING.md` |
| findings.json schema / 校验器 | `files/report-schema.json` + `files/validate-findings.cjs` + `files/validate-coverage-ledger.cjs` |

**通用攻击类（HUNTING 主力，任何时候都要有人盯）**：
- 跨组件信任差：A 校验后传 B，A 的保证与 B 的假设逐项对比（截断/类型强转/归一化/租户范围/插件权限）。
- 二次使用：存储时安全的数据在后续上下文变危险（字段名→JSON path、slug→文件路径、转义文本进原始渲染）。
- 权限/能力膨胀：token/插件/OAuth/MCP 能力在委托/刷新/缓存/角色变更后变宽。
- 时序与顺序：setup/迁移/软删/吊销缓存过期/check-use 窗口。
- 通配 hunter：不派类，专门找标准类之外的漏洞（读「无聊的」代码和 fallback 分支）。

## 5. 严重度标尺（报告口径统一）

- **critical**：未认证 → 代码执行 / 全库访问 / 任意账户接管。
- **high**：完全击穿显式安全控制且后果真实（认证绕过/跨租户读写/存储型脚本打他人/认证后 RCE/未认证远程打停共享服务）。
- **medium**：真实边界违规但爆炸半径有限/前提苛刻/影响面窄。
- **low**：非机密内部信息披露，或高投入低收益。
- **informational**：确认但影响极小，主要作为更大发现的组成部分。
- high/medium 分界：**是「完全击穿」还是「只是削弱」**。说不出具体损害 → 比感觉的更低。

## 6. 修复建议：最小有效源码修复

- 每个 confirmed 发现：指出代码必须强制的不变量 + **在最后一个可信决策点的最窄源码修复**。
- 优先给具体到仓库相对路径的改法和回归测试，不给泛泛加固清单。
- 审计只描述修复，**不直接改目标源码**。

## 7. 反模式（出现即重来）

1. 把 checklist 偏离当漏洞报。
2. 无可达边界违规的纵深防御建议。
3. 本地证据足够还去做 live/共享环境测试。
4. 猜测源码里不存在的 provider/proxy/浏览器/部署行为。
5. 把「同主体本就有权限的操作」报成越界结果。
6. 报告的解析器/运行时效果强于实际观测效果。
7. 输出无法去重/验证的纯散文 hunter 结果。
8. 重复上报沿用的旧 confirmed 记录，或拿它当范例锚定狩猎。
9. 给 `needs_validation` 定严重度。
10. 报告先于独立验证写，或散文与 JSON 两张皮。

## 8. KinetAios 场景速查（审计自家代码时的重点面）

- **IPC 桥面**：preload 暴露面是否最小（`contextBridge` 只暴露需要的通道）；renderer 不可达 Node；`confirm()` 唤起路径是否可被 renderer 伪造回复。
- **shell 工具链**：`.cmd` shell:true 注入面、`binEnv()` PATH 注入、policy 文件（agent.policy.json）旁路语义（坏 JSON = 旁路是刻意的，审计时按设计意图核对，不算漏洞）。
- **插件边界**：plugin 工具的 confirm 包装是否可被 manifest 绕开；marketplace.json renames 迁移是否可被伪造目录名触发错迁移。
- **SQL/FTS5**：recall/lessons 检索的参数化；FTS MATCH 语法注入（只造成查询错误 ≠ 越权，按影响定级）。
- **敏感数据落盘**：settings.json 明文 API key（已知 MVP 债务，按 hardening note 处理，不给漏洞级）。
