const port = Number(process.env.QA_FIXTURE_PORT ?? "3100");
const validEmail = process.env.QA_EMAIL ?? "qa@example.test";
const validPassword = process.env.QA_PASSWORD ?? "fixture-password";

const rows = Array.from({ length: 100 }, (_, index) => `<tr><td><button type="button">SKU-${index + 1}</button></td><td>Product ${index + 1}</td></tr>`).join("");
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture B2B cabinet</title></head>
<body>
  <main id="login-screen">
    <h1>Sign in</h1>
    <label>Email <input id="email" type="email" autocomplete="username"></label>
    <label>Password <input id="password" type="password" autocomplete="current-password"></label>
    <button id="sign-in" type="button">Sign in</button>
    <p id="login-error" role="alert"></p>
  </main>
  <main id="cabinet" hidden>
    <h1>Fixture cabinet</h1>
    <p id="authenticated-state">Signed in as test user</p>
    <nav><button type="button" data-section="overview">Overview</button><button type="button" data-section="reports">Reports</button><button type="button" data-section="products">Products</button></nav>
    <section id="section"><h2>Overview</h2><p>Read-only account summary</p></section>
    <button id="slow-check" type="button">Run slow check</button>
    <table><thead><tr><th>Product code <button id="header-search" type="button">⌕</button></th><th>Name</th></tr></thead><tbody>${rows}</tbody></table>
  </main>
  <script>
    const section = document.querySelector('#section');
    document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', async () => {
      if (button.dataset.section === 'reports') {
        const response = await fetch('/api/reports');
        section.innerHTML = response.ok ? '<h2>Reports</h2><p>Read-only reports content</p>' : '<h2>Reports</h2><p role="alert">Reports failed to load</p>';
        return;
      }
      section.innerHTML = '<h2>' + button.dataset.section + '</h2><p>Read-only ' + button.dataset.section + ' content</p>';
    }));
    document.querySelector('#slow-check').addEventListener('click', async () => {
      await fetch('/api/slow');
      section.innerHTML = '<h2>Slow check complete</h2><p>Slow response rendered</p>';
    });
    document.querySelector('#sign-in').addEventListener('click', async () => {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value, password: document.querySelector('#password').value }) });
      if (!response.ok) { document.querySelector('#login-error').textContent = 'Authentication failed'; return; }
      document.querySelector('#login-screen').hidden = true;
      document.querySelector('#cabinet').hidden = false;
    });
  </script>
</body></html>`;

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const credentials = await request.json() as { email?: string; password?: string };
      return new Response(null, { status: credentials.email === validEmail && credentials.password === validPassword ? 204 : 401 });
    }
    if (url.pathname === "/api/reports") return new Response("fixture failure", { status: 500 });
    if (url.pathname === "/api/slow") {
      const response = Promise.withResolvers<Response>();
      setTimeout(() => response.resolve(new Response("ok")), 2_700);
      return response.promise;
    }
    if (url.pathname === "/analytics") return new Response(null, { status: 204 });
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`Fixture B2B site listening on http://127.0.0.1:${server.port}`);
