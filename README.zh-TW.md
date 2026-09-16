# Autonomous Research System 設計文件

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Autonomous Research System：從 candidate / 實驗紀錄到可追溯論文包的自動化研究控制平面。沿用 DSH 的 Agent、Subagent、Goal、Workflow、Tools、Skills、持久化、沙箱、審批與模型路由；只新增研究控制語意。

## 目前執行基線

| 文件 | 內容 |
|---|---|
| [2026-08-20-autoresearch-ml-control-plane-design.md](docs/archive/designs/2026-08-20-autoresearch-ml-control-plane-design.md) | **唯一實作基線**：AutoResearchService + 最小狀態 + 動態 rubric + 自主迭代 + Domain Profile（ML v1） |
| [2026-08-16-candidate-to-paper-design.md](docs/archive/designs/2026-08-16-candidate-to-paper-design.md) | candidate → paper 全流程（預設入口） |
| [2026-08-16-records-to-paper-design.md](docs/archive/designs/2026-08-16-records-to-paper-design.md) | 既有實驗紀錄 → paper（第二入口） |
| [2026-08-16-idea-generation-design.md](docs/archive/designs/2026-08-16-idea-generation-design.md) | brainstorm + 候選生成 + 閘門 |
| [2026-08-15-hypothesis-local-pool-design.md](docs/archive/designs/2026-08-15-hypothesis-local-pool-design.md) | HypothesisPool 生命週期索引 |
| [2026-08-15-autoresearch-figures-and-experiment-design.md](docs/archive/designs/2026-08-15-autoresearch-figures-and-experiment-design.md) | 論文圖、可信實驗、消融規則 |

## 程式碼實作

- [packages/autoresearch/](packages/autoresearch/)：最小閉環 DSH 外掛（TypeScript），實作 `idea → plan → work → evidence → decide → paper | failure report`，沿用 DSH Agent/Subagent 系統。
  - 無頭執行：`cd packages/autoresearch && npm run run:headless`

## Handoff（領域流程執行手冊）

| 群組 | 檔案 |
|---|---|
| candidate→paper | [candidate-to-paper-handoff/](docs/workflows/candidate-to-paper-handoff/)：00 總控 + 01–10 各階段 |
| records→paper | [records-paper-handoff/](docs/workflows/records-paper-handoff/)：00 總控 + 01、02、04、05（含資料契約；寫作沿用 candidate 08） |
| 最小驗證 | [figure-validation/](experiments/figure-validation/)：圖管線、drawio MCP、pure LLM / drawio 結果 |

## 歷史 / 延期參考（非實作基線）

- `2026-08-15-autoresearch-ts-plugin-design.md`：交付物決策與三條論文路徑仍然有效；舊框架已收斂。
- `2026-08-15-autoresearch-detailed-design.md`：歷史實作級設計，保留復原與品質閘門原則。
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`：Paper Engine 規則仍然有效；階段協定已由 2026-08-20 取代。
- `2026-08-15-autoresearch-generalization-and-minimalism.md`：M4 泛化參考。

## 關鍵決策

1. 不實作第二套 Agent Runtime / EventBus / DAG / 工作佇列。
2. ML v1 只實作一個主要的 `AutoResearchService` + 最小 state/events。
3. 實驗執行方統一為 **Experiment Provider**（目前實作為 Athena）；Core 不依賴其私有型別。
4. 證據契約統一為 `evidence_chain.json`；論文引用統一為 `E:`/`B:` 標籤；四段 ID：`candidate_id → hypothesis_id → experiment_id → paper tag`。
5. 實驗前動態產生並凍結 rubric；失敗、DRAW、負面結果不得刪除。
6. 論文三路徑：Overleaf → local TeX → Markdown-only；編譯修復只受時間預算限制。
7. 通用化時機：第二個真實領域接入後再提煉最小 Domain Profile，不預先建立空殼介面。
