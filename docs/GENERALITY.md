# CUT generality contract

CUT may contain project-specific facts only in declarative project inputs and generated build artifacts. Executable code, prompts, styles, tests, and default behavior must not recognize a film, topic, source filename, brand, timestamp, title, or expected output.

## Permitted project data

- declared source paths and locked hashes
- source ranges selected by a planner
- narration, citations, titles, and factual claims
- theme tokens and requested style primitives
- explicit human overrides preserved as provenance

## Forbidden shortcuts

- branching on a project title, filename, topic, or source hash
- fixed timecodes or text inside a renderer
- a custom executable render script for a showcase film
- copying a reference edit shot-for-shot and calling it autonomous
- model-generated shell commands, filter graphs, or arbitrary code
- silent fallback to undeclared media or fabricated quotations
- evaluating generality only on the film used to develop a feature

## Merge gate

A production feature is generalized only when:

1. it is represented in public typed `.cut` syntax and CutAVIR;
2. untrusted source and loaded IR are bounded and validated;
3. the runtime executes it without a model or project-specific shell path;
4. provenance identifies its source inputs;
5. at least one unrelated fixture exercises the same implementation;
6. executable code contains none of the showcase project's identifying facts.

CUT source is the canonical production artifact, not a wrapper around a hidden
plan. A constrained planner may author the same public source from indexed
evidence, but planning remains separate from deterministic checking, locking
and rendering so a model cannot bypass validation.

The 1.0 product gate is broader than an individual-feature merge gate. It
requires six substantially different redistributable projects plus a traceable
50–80-pattern benchmark across dialogue, product/social, music, educational/
data, narrative/title and documentary grammar. At least 90% of those patterns
must be cleanly executable, mandatory editorial/audio foundations may have no
unexpressible pattern, and remaining limits may not force one visual house
style. This document defines the public benchmark boundary; the current
supported surface and remaining release gates are summarized in
[`CAPABILITIES.md`](CAPABILITIES.md) and [`ROADMAP_1_0.md`](ROADMAP_1_0.md).
