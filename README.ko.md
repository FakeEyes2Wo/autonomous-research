# Autonomous Research System 설계 문서

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Autonomous Research System: candidate / 실험 기록에서 추적 가능한 논문 패키지까지 이어지는 자동화 연구 제어 평면입니다. DSH의 Agent, Subagent, Goal, Workflow, Tools, Skills, 영속화, 샌드박스, 승인, 모델 라우팅을 그대로 재사용하며, 새로 추가하는 것은 연구 제어 시맨틱뿐입니다.

## 현재 구현 기준선

| 문서 | 내용 |
|---|---|
| [2026-08-20-autoresearch-ml-control-plane-design.md](docs/archive/designs/2026-08-20-autoresearch-ml-control-plane-design.md) | **유일한 구현 기준선**: AutoResearchService + 최소 상태 + 동적 rubric + 자율 반복 + Domain Profile (ML v1) |
| [2026-08-16-candidate-to-paper-design.md](docs/archive/designs/2026-08-16-candidate-to-paper-design.md) | candidate → paper 전체 흐름 (기본 진입점) |
| [2026-08-16-records-to-paper-design.md](docs/archive/designs/2026-08-16-records-to-paper-design.md) | 기존 실험 기록 → paper (두 번째 진입점) |
| [2026-08-16-idea-generation-design.md](docs/archive/designs/2026-08-16-idea-generation-design.md) | 브레인스토밍 + 후보 생성 + 게이트 |
| [2026-08-15-hypothesis-local-pool-design.md](docs/archive/designs/2026-08-15-hypothesis-local-pool-design.md) | HypothesisPool 생명주기 인덱스 |
| [2026-08-15-autoresearch-figures-and-experiment-design.md](docs/archive/designs/2026-08-15-autoresearch-figures-and-experiment-design.md) | 논문 그림, 신뢰할 수 있는 실험, 애블레이션 규칙 |

## 코드 구현

- [packages/autoresearch/](packages/autoresearch/): 최소 폐루프 DSH 플러그인 (TypeScript). `idea → plan → work → evidence → decide → paper | failure report`를 구현하며 DSH의 Agent/Subagent 시스템을 재사용합니다.
  - 헤드리스 실행: `cd packages/autoresearch && npm run run:headless`

## Handoff (도메인 워크플로 실행 매뉴얼)

| 그룹 | 파일 |
|---|---|
| candidate→paper | [candidate-to-paper-handoff/](docs/workflows/candidate-to-paper-handoff/): 00 총괄 + 01–10 각 단계 |
| records→paper | [records-paper-handoff/](docs/workflows/records-paper-handoff/): 00 총괄 + 01, 02, 04, 05 (데이터 계약 포함, 작성은 candidate 08을 재사용) |
| 최소 검증 | [figure-validation/](experiments/figure-validation/): 그림 파이프라인, drawio MCP, pure LLM / drawio 결과 |

## 이력 / 보류 참고 자료 (구현 기준선 아님)

- `2026-08-15-autoresearch-ts-plugin-design.md`: 산출물 결정과 세 가지 논문 경로는 여전히 유효하며, 구 프레임워크는 정리되었습니다.
- `2026-08-15-autoresearch-detailed-design.md`: 과거의 구현 수준 설계로, 복구 및 품질 게이트 원칙을 보존하기 위해 남겨 두었습니다.
- `2026-08-15-autoresearch-protocols-and-paper-engine.md`: Paper Engine 규칙은 여전히 유효하지만, 단계 프로토콜은 2026-08-20 문서로 대체되었습니다.
- `2026-08-15-autoresearch-generalization-and-minimalism.md`: M4 일반화 참고 자료.

## 핵심 결정 사항

1. 두 번째 Agent Runtime / EventBus / DAG / 작업 큐는 구현하지 않는다.
2. ML v1에서는 주요 `AutoResearchService` 하나와 최소한의 state/events만 구현한다.
3. 실험 실행 주체는 **Experiment Provider**로 통일한다 (현재 구현은 Athena). Core는 그 비공개 타입에 의존하지 않는다.
4. 증거 계약은 `evidence_chain.json`으로 통일하고, 논문 인용은 `E:`/`B:` 라벨로 통일한다. 4단 ID는 `candidate_id → hypothesis_id → experiment_id → paper tag`.
5. rubric은 실험 전에 동적으로 생성하여 고정한다. 실패, DRAW, 부정적 결과는 삭제해서는 안 된다.
6. 논문 세 가지 경로: Overleaf → local TeX → Markdown-only. 컴파일 수정은 시간 예산에만 제약을 받는다.
7. 일반화 시점: 두 번째 실제 도메인을 연동한 후에 최소한의 Domain Profile을 추출한다. 빈 인터페이스를 미리 만들지 않는다.
