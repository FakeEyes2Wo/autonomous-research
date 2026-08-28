# Evidence Chain 功能化设计

> 目标：让 evidence chain 成为学术论文写作的“事实底座”，而不是原始数据堆砌。

---

## 1. 设计原则

1. **不堆字段**：字段按功能归属，每个字段只出现在它真正起作用的层。
2. **不照搬 research tree**：evidence chain 不是 raw tree 的复制品，而是面向论文写作的结构化事实。
3. **符合学术写作**：论文按“问题 → 缺口 → 方法 → 发现 → 洞见 → 边界”组织，evidence chain 只提供支撑。
4. **论文中不得出现代码 / 文件名 / 路径 / 内部标识符**。

---

## 2. 五层功能模型

### 第 1 层：证据源层（sources）

只存事实，不做解读。

```ts
EvidenceItem {
  id: string          // 与 ResearchTree evidence id 一致
  kind: 'experimental' | 'theoretical' | 'observational' | 'reproduced'
  statement: string   // 一句话事实
  source: string      // 来源描述
  metric?: { name, value, baseline?, delta? }
  verdict: 'supports' | 'refutes' | 'inconclusive'
  artifacts: string[]
}
```

### 第 2 层：主张层（claims）

只存论文需要论证的命题。

```ts
Claim {
  id: string          // 与 ResearchTree hypothesis / HypothesisPool entry id 一致
  level: 'main' | 'section' | 'supporting'
  statement: string
  priority: 'high' | 'medium' | 'low'
  sourceHypothesisId?: string
}
```

### 第 3 层：支持映射层（support）

只存“证据如何支持主张”。

```ts
SupportLink {
  claimId: string
  evidenceId: string
  relation: 'supports' | 'refutes' | 'partially_supports' | 'contextual'
  strength: 'direct' | 'corroborating' | 'indirect'
  confidence: 'high' | 'medium' | 'low'
  usedInPaper: boolean
}
```

### 第 4 层：叙事摘要层（briefs）

只给写作 Agent 提供精选后的论证摘要，不提供全量数据。

```ts
NarrativeBrief {
  claimId: string
  section: string
  narrative: string
  keyEvidenceIds: string[]
  supportingEvidenceIds: string[]
  contentiousIds: string[]
  caveats: string[]
}
```

### 第 5 层：审计层（audit）

独立检查，不参与写作。

```ts
EvidenceAuditReport {
  missingEvidenceForClaims: string[]
  weakEvidenceClaims: string[]
  conflictingEvidence: string[]
  unusedHighPriorityEvidence: string[]
}
```

---

## 3. ID 联动设计

不另造 ID，全部复用原始 ID：

| 对象 | ID |
|---|---|
| Claim | `hyp_xxx`（与 ResearchTree / HypothesisPool 一致） |
| EvidenceItem | `evi_xxx`（与 ResearchTree 一致） |
| SupportLink | 直接连接上述两个原始 ID |

一致性校验：

1. 每个 Claim 必须存在于 ResearchTree hypothesis 和 HypothesisPool entry；
2. 每个 EvidenceItem 必须存在于 ResearchTree evidence 和至少一个 HypothesisPool `evidence_ids[]`；
3. 不支持自动伪造 ID；
4. 不一致时标记审计错误，不静默修复。

---

## 4. 文件布局

```text
<run>/
  evidence/
    meta.json
    sources.json
    claims.json
    support.json
    briefs.json
    audit.json
    summary.md
```

- `summary.md` 是给写作 Agent 的紧凑叙事摘要；
- 原始长文本保留在 artifact / sources；
- briefs 只存摘要，不做信息堆砌。

---

## 5. JSON 生成容错

LLM 可能无法生成合法 JSON，统一采用：

```text
1. 直接 JSON.parse
2. 提取 ```json 代码块
3. 提取第一个 { ... } 或 [ ... ]
4. 简单修复：
     - 去掉尾逗号
     - 去掉 markdown 围栏
     - 修复未闭合引号/括号
5. 再次 parse
6. 仍失败 → 抛 AGENT_FAILED，并保留原始输出
```

修复只处理格式，不修改 ID。缺少 `id` 字段时不允许自动补造 ID。

---

## 6. 论文写作消费方式

写作 Agent 只接收：

```text
evidence/claims.json
evidence/briefs.json
evidence/summary.md
```

规则：

- 主结论只用 `keyEvidenceIds` 中的强证据；
- 次要佐证才使用 `supportingEvidenceIds`；
- 矛盾证据必须学术化呈现，不能隐藏；
- 论文正文禁止出现代码、文件名、路径、函数名、配置名、内部 ID。

---

## 7. 实现状态

- 当前代码仍以原始 `evidence_chain.json` 为主；
- 功能化分层属于目标设计；
- 建议按“sources → claims → support → briefs → audit”逐步实现。
