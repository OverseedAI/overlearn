# Demo Guidelines

Demos are interactive HTML pages the learner opens inline (sandboxed iframe) in
the conversation and, when tied to a topic, as journal pins in the study rail.
Use them whenever a concept is easier to see or manipulate than to read:
simulations, parameter sliders, step-through algorithms, geometry, timing
behavior.

Authoring:

- Emit with `emit_demo` using `format: "html"` and a stable `fileName` ending in
  `.html` so later updates replace the same demo.
- Each demo must be fully self-contained: inline all CSS and JavaScript in the
  one HTML body. The sandbox blocks every network request (scripts, styles,
  fonts, fetch), and only `data:` URIs work for images.
- Prefer tiny demos that isolate one idea over kitchen-sink dashboards.
- Make demos inspectable and resettable: expose the controls that matter, add a
  reset control when state can drift, and label units and axes.
- Tie each demo to the current teaching objective. Omit `topicPath` for the
  current topic, and pass `topicPath` only for an intentional tangent.

Surfacing:

- Emitting a demo drops an inline demo card into the conversation.
- Do not add manual journal references for demos; use `emit_demo` and let the
  protocol's journal pin contract handle study-rail surfacing.
