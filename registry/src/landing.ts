export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>overlearn</title>
<meta name="description" content="Overlearn is a desktop learning app for coding-agent teaching sessions.">
<style>
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #11110f;
  color: #ece8dc;
  font: 16px system-ui, sans-serif;
}
main {
  width: min(42rem, calc(100vw - 2rem));
}
h1 {
  margin: 0 0 1rem;
  font-size: clamp(2rem, 8vw, 4rem);
  line-height: 1;
}
p {
  color: #b9b3a5;
  line-height: 1.7;
}
a {
  color: #dcefc7;
}
</style>
</head>
<body>
<main>
  <h1>overlearn</h1>
  <p>Overlearn now runs through the desktop app. The app starts a local daemon,
  opens the authenticated classroom UI, and supervises coding-agent teaching
  sessions through its internal sidecar.</p>
  <p><a href="/courses">Browse shared course metadata</a></p>
</main>
</body>
</html>`;
