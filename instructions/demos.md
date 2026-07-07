# Demo Guidelines

Demos are interactive HTML pages the learner opens inline (sandboxed iframe) in
the conversation or inside a lesson. Use them whenever a concept is easier to
see or manipulate than to read: simulations, parameter sliders, step-through
algorithms, geometry, timing behavior.

Authoring:

- Emit with `emit_demo` using `format: "html"` and a stable `fileName` ending in
  `.html` so later updates replace the same demo.
- Each demo must be fully self-contained: inline all CSS and JavaScript in the
  one HTML body. The sandbox blocks every network request (scripts, styles,
  fonts, fetch), and only `data:` URIs work for images.
- Prefer tiny demos that isolate one idea over kitchen-sink dashboards.
- Make demos inspectable and resettable: expose the controls that matter, add a
  reset control when state can drift, and label units and axes.
- Tie each demo to the current lesson objective, and attach it to the relevant
  topic with `topicPath`.

Surfacing:

- Emitting a demo drops an inline demo card into the conversation.
- Reference a demo inside a lesson with a `:::demo <file.html> "Title"` line so
  it renders as an embedded card in the study rail.
