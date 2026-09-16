---
title: "Retrieval-Augmented Generation System"
kind: architecture
nodes:
  - "Query|text"
  - "Encoder|embedding"
  - "Vector Index|database"
  - "Retriever|magnifier"
  - "Reranker|scale"
  - "Generator|llm"
  - "Corpus|documents"
edges:
  - "Query -> Encoder"
  - "Query -> Retriever"
  - "Corpus -> Encoder"
  - "Encoder -> Vector Index"
  - "Vector Index -> Retriever"
  - "Retriever -> Reranker"
  - "Reranker -> Generator"
  - "Query -> Generator"
groups:
  - "Indexing: Corpus, Encoder, Vector Index"
  - "Inference: Query, Retriever, Reranker, Generator"
annotations:
  - "Retriever: top-k candidates"
  - "Reranker: cross-encoder"
style: academic-minimal
---
Paper-level system diagram of a two-stage retrieval-augmented generation pipeline. Indexing happens offline on the left, inference online on the right. Use two dashed group containers. Show query going both to the retriever and directly to the generator. All labels editable text, vector-style boxes, orthogonal edges with one accent color.
