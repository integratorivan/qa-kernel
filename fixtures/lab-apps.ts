const port = Number(process.env.QA_LAB_PORT ?? "3200");
const validEmail = process.env.QA_EMAIL ?? "qa@example.test";
const validPassword = process.env.QA_PASSWORD ?? "fixture-password";
const healthToken = process.env.QA_LAB_HEALTH_TOKEN ?? "";

const tableRows = Array.from({ length: 80 }, (_, index) => `<tr><td><button type="button">SKU-${index + 1}</button></td><td>Product ${index + 1}</td></tr>`).join("");

const cabinet = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lab Cabinet</title></head>
<body>
<main id="login-screen">
  <h1>Sign in</h1>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label>
  <button id="sign-in" type="button" disabled>Sign in</button>
  <p id="login-error" role="alert"></p>
</main>
<main id="cabinet" hidden>
  <h1>Lab cabinet</h1>
  <p id="authenticated-state">Signed in as test user</p>
  <nav>
    <button type="button" data-section="overview">Overview</button>
    <button type="button" data-section="reports">Reports</button>
    <button type="button" data-section="products">Products</button>
  </nav>
  <section id="section"><h2>Overview</h2><p>Read-only account summary</p></section>
  <button id="slow-check" type="button">Run slow check</button>
  <table><thead><tr><th>Product code <button id="header-search" type="button">⌕</button></th><th>Name</th></tr></thead><tbody>${tableRows}</tbody></table>
  <button id="below" style="margin-top:1400px" type="button">Below viewport</button>
</main>
<script>
  const params = new URLSearchParams(location.search);
  const email = document.querySelector('#email');
  const password = document.querySelector('#password');
  const signIn = document.querySelector('#sign-in');
  const sync = () => { signIn.disabled = !(email.value && password.value); };
  email.addEventListener('input', sync);
  password.addEventListener('input', sync);
  document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', async () => {
    const section = document.querySelector('#section');
    if (button.dataset.section === 'reports') {
      const response = await fetch('/api/reports');
      section.innerHTML = response.ok ? '<h2>Reports</h2><p>Read-only reports content</p>' : '<h2>Reports</h2><p role="alert">Reports failed to load</p>';
      return;
    }
    section.innerHTML = '<h2>' + button.dataset.section + '</h2><p>Read-only ' + button.dataset.section + ' content</p>';
  }));
  document.querySelector('#slow-check').addEventListener('click', async () => {
    await fetch('/api/slow');
    document.querySelector('#section').innerHTML = '<h2>Slow check complete</h2><p>Slow response rendered</p>';
  });
  document.querySelector('#below').addEventListener('click', () => {
    document.querySelector('#section').innerHTML = '<h2>Below control clicked</h2><p>Offscreen interaction completed</p>';
  });
  signIn.addEventListener('click', async () => {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, password: password.value }) });
    if (!response.ok) { document.querySelector('#login-error').textContent = 'Authentication failed'; return; }
    document.querySelector('#login-screen').hidden = true;
    document.querySelector('#cabinet').hidden = false;
  });
  if (params.get('state') === 'signed-in') {
    document.querySelector('#login-screen').hidden = true;
    document.querySelector('#cabinet').hidden = false;
  }
</script>
</body></html>`;

const catalog = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lab Catalog</title></head>
<body>
  <h1>Lab catalog</h1>
  <label>Search <input id="search" type="search" placeholder="SKU or name"></label>
  <button id="apply-search" type="button">Search catalog</button>
  <button id="filter-wine" type="button">Filter wine</button>
  <button id="load-slow" type="button">Load slow list</button>
  <p id="status">Ready</p>
  <div id="scroll-box" style="height:160px;overflow:auto;border:1px solid #ccc">
    <button type="button">Top of list</button>
    <div style="height:700px"></div>
    <button id="deep-item" type="button">Deep catalog item</button>
  </div>
  <ul id="results"></ul>
<script>
  const params = new URLSearchParams(location.search);
  const results = document.querySelector('#results');
  const status = document.querySelector('#status');
  const render = (items) => { results.innerHTML = items.map((item) => '<li><button type="button">' + item + '</button></li>').join('') || '<li>No catalog matches</li>'; };
  document.querySelector('#apply-search').addEventListener('click', () => {
    const query = document.querySelector('#search').value.trim().toLowerCase();
    const all = ['SKU-1 Wine', 'SKU-2 Water', 'SKU-3 Snacks'];
    render(query ? all.filter((item) => item.toLowerCase().includes(query)) : all);
    status.textContent = 'Search complete';
  });
  document.querySelector('#filter-wine').addEventListener('click', () => {
    render(['SKU-1 Wine']);
    status.textContent = 'Wine filter applied';
  });
  document.querySelector('#load-slow').addEventListener('click', async () => {
    status.textContent = 'Loading';
    await fetch('/api/slow');
    render(['SKU-10 Late', 'SKU-11 Late']);
    status.textContent = 'Slow list ready';
  });
  if (params.get('state') === 'empty') { render([]); status.textContent = 'Empty catalog'; }
  else if (params.get('state') === 'results') { render(['SKU-1 Wine', 'SKU-2 Water']); status.textContent = 'Seed results'; }
  else render(['SKU-1 Wine', 'SKU-2 Water', 'SKU-3 Snacks']);
</script>
</body></html>`;

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__qa_health") return new Response(healthToken);
    if (url.pathname === "/api/login") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const credentials = await request.json() as { email?: string; password?: string };
      return new Response(null, { status: credentials.email === validEmail && credentials.password === validPassword ? 204 : 401 });
    }
    if (url.pathname === "/api/reports") return new Response("lab failure", { status: 500 });
    if (url.pathname === "/api/slow") {
      const pending = Promise.withResolvers<Response>();
      setTimeout(() => pending.resolve(new Response("ok")), 2_700);
      return pending.promise;
    }
    if (url.pathname.startsWith("/catalog")) return new Response(catalog, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(cabinet, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`Lab apps listening on http://127.0.0.1:${server.port}/cabinet and /catalog`);
