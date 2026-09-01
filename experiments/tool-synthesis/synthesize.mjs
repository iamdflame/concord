// Tool synthesis for pages that never heard of WebMCP.
//
// The spec assumes sites publish tools. That assumption is what makes every
// WebMCP project look alike, and it is wrong in an interesting way: the web has
// been publishing machine-readable capability declarations for over a decade
// and almost nothing consumed them. schema.org potentialAction is a
// standardised way to declare an action. OpenSearch is a standardised way to
// declare a query interface. A <form> with labelled controls is a typed
// function with named parameters. ARIA says what a control is for.
//
// So this is mostly not inference. It is reading declarations that are already
// there. Every tool records which tier it came from, because a synthesiser that
// cannot say how much it guessed is not measurable, and the whole question is
// whether the output is composable or mush.
//
//   tier 1  schema.org potentialAction   the site declared this action
//   tier 2  OpenSearch descriptor        the site declared this query interface
//   tier 3  form + label/ARIA semantics  the site declared this shape
//   tier 4  inferred from controls       we guessed
//
// Written as a global rather than an export so one source can serve both the
// extension and the headless probe.

globalThis.__RING0_SYNTH__ = function synthesize(doc = document) {
  const tools = [];
  const seen = new Set();

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const slug = (s, fallback) => {
    const out = clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    return out || fallback;
  };
  const uniq = (name) => {
    let n = name, i = 2;
    while (seen.has(n)) n = `${name}_${i++}`;
    seen.add(n);
    return n;
  };

  // Name tools after the host, not the title. Titles gave
  // "wikipedia_the_free_encyclopedia.search" and split "arxiv.org" into
  // "arxiv_org_e" -- a tool name is an address, and it has to be stable and
  // short enough to compose with.
  const site = slug(location.hostname.replace(/^www\./, '').split('.').slice(0, -1).join('_')
    || location.hostname, 'site');

  /** Visible text that explains a control: label, aria, placeholder, title. */
  function describe(el) {
    const byId = el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return clean(
      el.getAttribute('aria-label')
      ?? byId?.textContent
      ?? el.closest('label')?.textContent
      ?? el.getAttribute('placeholder')
      ?? el.getAttribute('title')
      ?? (el.getAttribute('aria-labelledby')
          && doc.getElementById(el.getAttribute('aria-labelledby'))?.textContent)
      ?? el.name
      ?? '');
  }

  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

  // Controls that steer the page's own chrome are not capabilities. Wikipedia
  // published five "tools" that were font-size and theme toggles; a composition
  // layer that offers those alongside search is offering noise.
  const CHROME_ISH = /^(skin|theme|appearance|pref|prefs|preference|display|font|width|layout|cookie|consent|csrf|token|nonce|utf8|authenticity|_[a-z]+)/;
  const isChrome = (key, el) =>
    CHROME_ISH.test(key)
    || /^(radio|checkbox)$/.test((el.type ?? '').toLowerCase()) && CHROME_ISH.test(key);
  const TYPES = { number: 'number', range: 'number', checkbox: 'boolean', email: 'string', date: 'string' };

  function schemaFor(form) {
    const properties = {};
    const required = [];
    let labelled = 0, total = 0;

    for (const el of form.querySelectorAll('input, select, textarea')) {
      const type = (el.type ?? '').toLowerCase();
      if (SKIP.has(type) || el.disabled) continue;
      const key = slug(el.name || el.id || describe(el), '');
      if (!key || properties[key] || isChrome(key, el)) continue;
      total += 1;

      const description = describe(el);
      if (description && description !== el.name) labelled += 1;

      const prop = { type: TYPES[type] ?? 'string' };
      if (description) prop.description = description.slice(0, 160);
      if (el.tagName === 'SELECT') {
        const options = [...el.options].map((o) => o.value).filter(Boolean).slice(0, 40);
        if (options.length) { prop.enum = options; prop.type = 'string'; }
      }
      properties[key] = prop;
      if (el.required) required.push(key);
    }
    return { schema: { type: 'object', properties, ...(required.length && { required }) }, labelled, total };
  }

  // ── tier 1: the site declared an action in schema.org ─────────────────────
  for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(node.textContent); } catch { continue; }
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const item = queue.shift();
      if (!item || typeof item !== 'object') continue;
      for (const v of Object.values(item)) if (v && typeof v === 'object') queue.push(v);

      const actions = [item.potentialAction].flat().filter(Boolean);
      for (const action of actions) {
        const template = action.target?.urlTemplate ?? action.target;
        if (typeof template !== 'string') continue;
        const params = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1].replace(/^\?*/, ''));
        const kind = slug(action['@type'] ?? 'action', 'action').replace(/_action$/, '');
        tools.push({
          name: uniq(`${site}.${kind}`),
          title: clean(action.name ?? action['@type'] ?? 'Declared action'),
          description: clean(action.description
            ?? `${action['@type'] ?? 'Action'} declared by ${location.hostname} in schema.org metadata.`),
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(params.map((p) => [slug(p, 'q'), { type: 'string', description: p }])),
            required: params.map((p) => slug(p, 'q')),
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          _tier: 1, _origin: 'schema.org potentialAction', _template: template,
        });
      }
    }
  }

  // ── tier 2: the site declared a query interface via OpenSearch ────────────
  for (const link of doc.querySelectorAll('link[rel~="search"][type*="opensearch"]')) {
    tools.push({
      name: uniq(`${site}.opensearch`),
      title: clean(link.title || 'Search'),
      description: `Search ${location.hostname} through the OpenSearch interface it publishes.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms' } },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      _tier: 2, _origin: 'OpenSearch descriptor', _descriptor: link.href,
    });
  }

  // ── tier 3/4: forms are typed functions with named parameters ─────────────
  for (const form of doc.querySelectorAll('form')) {
    const { schema, labelled, total } = schemaFor(form);
    // A form with nothing but chrome controls left is not a capability.
    if (!total) continue;

    const submit = form.querySelector('[type="submit"], button:not([type="button"])');
    const heading = form.closest('section, article, div')
      ?.querySelector('h1, h2, h3, legend, [role="heading"]');
    const intent = clean(form.getAttribute('aria-label') ?? form.name ?? submit?.value
      ?? submit?.textContent ?? heading?.textContent ?? form.id ?? 'submit');

    const method = (form.method || 'get').toLowerCase();
    const searchy = method === 'get'
      && Object.keys(schema.properties).some((k) => /^(q|query|search|s|term|keywords?)$/.test(k));

    // Every parameter carrying a human label means the site described its own
    // shape. Nothing labelled means we are naming things after HTML attributes,
    // which is where synthesis stops being reading and starts being guessing.
    const tier = labelled / total >= 0.5 ? 3 : 4;

    tools.push({
      name: uniq(`${site}.${slug(intent, searchy ? 'search' : 'submit')}`),
      title: intent.slice(0, 80) || 'Submit form',
      description: clean(
        (searchy ? `Search ${location.hostname}` : intent ? `${intent} on ${location.hostname}` : `Submit the ${
          Object.keys(schema.properties).slice(0, 3).join(', ')} form on ${location.hostname}`)
        + '. Parameters: ' + Object.entries(schema.properties)
            .map(([k, v]) => v.description ? `${k} (${v.description})` : k).slice(0, 6).join(', ') + '.'),
      inputSchema: schema,
      annotations: {
        readOnlyHint: method === 'get',
        // Anything this returns is authored by the site or its users, not by us.
        untrustedContentHint: true,
      },
      _tier: tier, _origin: tier === 3 ? 'form with labelled controls' : 'form, unlabelled controls',
      _selector: form.id ? `#${form.id}` : null,
      _fields: total, _labelled: labelled,
    });
  }

  // ── tier 4: interactive controls with accessible names ────────────────────
  // Modern apps do not use <form>. An action is a button with a click handler,
  // and the only thing that says what it does is its accessible name. ARIA is a
  // declaration, so this is not pure guessing -- but it is a weaker signal than
  // a typed form, and it is counted separately for exactly that reason.
  const CONTROL = '[role="button"], button, [role="switch"], [role="menuitem"], [role="tab"], [role="combobox"]';
  const VERBISH = /^(add|create|new|post|submit|send|save|edit|delete|remove|share|open|start|book|buy|order|apply|upload|download|filter|sort|subscribe|follow|comment|reply|report|export|import|copy|move|assign|invite|publish|schedule|pay|checkout|install|fork|watch|star)\b/i;

  const controls = [];
  for (const el of doc.querySelectorAll(CONTROL)) {
    if (el.closest('form') || el.disabled) continue;
    const rect = el.getBoundingClientRect?.();
    if (rect && (rect.width < 8 || rect.height < 8)) continue;      // not really on screen
    const label = clean(el.getAttribute('aria-label') ?? el.textContent ?? el.title ?? '');
    if (!label || label.length > 46 || !VERBISH.test(label)) continue;  // an action reads as a verb
    const key = slug(label, '');
    if (!key || controls.includes(key)) continue;
    controls.push(key);
    tools.push({
      name: uniq(`${site}.${key}`),
      title: label,
      description: `${label} on ${location.hostname}. Exposed as a control with an accessible name.`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      _tier: 4, _origin: 'ARIA-named control',
    });
  }

  return {
    origin: location.origin,
    title: clean(doc.title),
    tools,
    counts: tools.reduce((acc, t) => (acc[`tier${t._tier}`] = (acc[`tier${t._tier}`] ?? 0) + 1, acc), {}),
  };
};
