# Graph Report - .  (2026-04-21)

## Corpus Check
- Corpus is ~39 words - fits in a single context window. You may not need a graph.

## Summary
- 9 nodes · 8 edges · 2 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Image Understanding Service|Image Understanding Service]]
- [[_COMMUNITY_VPC Image API|VPC Image API]]

## God Nodes (most connected - your core abstractions)
1. `Retina` - 7 edges
2. `Image-to-text API` - 2 edges
3. `Self-hostable image understanding API` - 1 edges
4. `Bring your own LLM keys` - 1 edges
5. `Bedrock endpoint` - 1 edges
6. `Sensing layer for your app` - 1 edges
7. `Your own VPC` - 1 edges
8. `Drop-in API service for image understanding` - 1 edges
9. `Image understanding` - 1 edges

## Surprising Connections (you probably didn't know these)
- `Image-to-text API` --rationale_for--> `Retina`  [EXTRACTED]
  README.md → README.md  _Bridges community 0 → community 1_

## Communities

### Community 0 - "Image Understanding Service"
Cohesion: 0.29
Nodes (7): Bedrock endpoint, Bring your own LLM keys, Drop-in API service for image understanding, Image understanding, Retina, Self-hostable image understanding API, Sensing layer for your app

### Community 1 - "VPC Image API"
Cohesion: 1.0
Nodes (2): Image-to-text API, Your own VPC

## Knowledge Gaps
- **7 isolated node(s):** `Self-hostable image understanding API`, `Bring your own LLM keys`, `Bedrock endpoint`, `Sensing layer for your app`, `Your own VPC` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `VPC Image API`** (2 nodes): `Image-to-text API`, `Your own VPC`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Retina` connect `Image Understanding Service` to `VPC Image API`?**
  _High betweenness centrality (0.964) - this node is a cross-community bridge._
- **Why does `Image-to-text API` connect `VPC Image API` to `Image Understanding Service`?**
  _High betweenness centrality (0.250) - this node is a cross-community bridge._
- **What connects `Self-hostable image understanding API`, `Bring your own LLM keys`, `Bedrock endpoint` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._