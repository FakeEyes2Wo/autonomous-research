[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# Autonomous Research System 設計ドキュメント

Autonomous Research System：candidate / 実験記録からトレーサブルな論文パッケージまでを自動化する研究コントロールプレーン。DSH の Agent、Subagent、Goal、Workflow、Tools、Skills、永続化、サンドボックス、承認、モデルルーティングをそのまま再利用し、新規に追加するのは研究制御のセマンティクスのみ。

## 現行の実装ベースライン

| ドキュメント | 内容 |
|---|---|
| [2026-08-20-autoresearch-ml-control-plane-design.md](2026-08-20-autoresearch-ml-control-plane-design.md) | **唯一の実装ベースライン**：AutoResearchService + 最小状態 + 動的 rubric + 自律イテレーション + Domain Profile（ML v1） |
| [2026-08-16-candidate-to-paper-design.md](2026-08-16-candidate-to-paper-design.md) | candidate → paper の全工程（デフォルトの入口） |
| [2026-08-16-records-to-paper-design.md](2026-08-16-records-to-paper-design.md) | 既存の実験記録 → paper（第二の入口） |
| [2026-08-16-idea-generation-design.md](2026-08-16-idea-generation-design.md) | brainstorm + 候補生成 + ゲート |
| [2026-08-15-hypothesis-local-pool-design.md](2026-08-15-hypothesis-local-pool-design.md) | HypothesisPool のライフサイクル索引 |
| [2026-08-15-autoresearch-figures-and-experiment-design.md](2026-08-15-autoresearch-figures-and-experiment-design.md) | 論文図、信頼できる実験、アブレーションのルール |

## コード実装

- [packages/autoresearch/](packages/autoresearch/)：最小クローズドループの DSH プラグイン（TypeScript）。`idea → plan → work → evidence → decide → paper | failure report` を実装し、DSH の Agent/Subagent システムを再利用する。
  - ヘッドレス実行：`cd packages/autoresearch && npm run run:headless`

## Handoff（ドメインフロー実行マニュアル）

| グループ | ファイル |
|---|---|
| candidate→paper | [candidate-to-paper-handoff/](candidate-to-paper-handoff/)：00 総括 + 01–10 の各フェーズ |
| records→paper | [records-paper-handoff/](records-paper-handoff/)：00 総括 + 01、02、04、05（データ契約を含む。執筆は candidate 08 を再利用） |
| 最小検証 | [verify_exp/](verify_exp/)：図パイプライン、drawio MCP、pure LLM / drawio の結果 |

## 履歴 / 保留中の参考資料（実装ベースラインではない）

- `2026-08-15-autoresearch-ts-plugin-design.md`：成果物に関する決定と 3 つの論文パスは引き続き有効。旧フレームワークは収束済み。
- `2026-08-15-autoresearch-detailed-design.md`：過去の実装レベル設計。リカバリと品質ゲートの原則を保持するために残している。
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`：Paper Engine のルールは引き続き有効。フェーズプロトコルは 2026-08-20 の文書に置き換えられた。
- `2026-08-15-autoresearch-generalization-and-minimalism.md`：M4 汎化の参考資料。

## 主要な決定事項

1. 2 つ目の Agent Runtime / EventBus / DAG / タスクキューは実装しない。
2. ML v1 では主要な `AutoResearchService` を 1 つと、最小限の state/events のみを実装する。
3. 実験の実行主体は **Experiment Provider** に統一する（現行の実装は Athena）。Core はその private な型に依存しない。
4. 証跡の契約は `evidence_chain.json` に統一し、論文の引用は `E:`/`B:` ラベルに統一する。4 段構成の ID は `candidate_id → hypothesis_id → experiment_id → paper tag`。
5. rubric は実験前に動的生成して凍結する。失敗、DRAW、ネガティブな結果を削除してはならない。
6. 論文の 3 経路：Overleaf → local TeX → Markdown-only。コンパイル修正の制約は時間予算のみ。
7. 汎化のタイミング：2 つ目の実ドメインを接続した後に最小の Domain Profile を抽出する。空のインターフェースを先回りして作らない。
