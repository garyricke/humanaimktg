/**
 * Netlify Function: chat
 *
 * Required environment variables (set in Netlify → Site → Environment variables):
 *   APP_PASSWORD       — password to protect the editor
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   GITHUB_TOKEN       — a GitHub personal access token (repo scope)
 *   GITHUB_OWNER       — GitHub username or org (e.g. "johndoe")
 *   GITHUB_REPO        — repository name (e.g. "my-site")
 *   GITHUB_FILE_PATH   — path to the HTML file in the repo (default: "index.html")
 */

const GITHUB_FILE = process.env.GITHUB_FILE_PATH || 'index.html';

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

exports.handler = async (event) => {
  // ── CORS headers ──────────────────────────────────────────────────────────
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...headers, 'Access-Control-Allow-Headers': 'Content-Type' } };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { password, action, message, history = [] } = body;

  // ── Validate password ──────────────────────────────────────────────────────
  if (!password || password !== process.env.APP_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // ── Auth-only check (login ping) ───────────────────────────────────────────
  if (action === 'auth') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (action !== 'edit' && action !== 'undo') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or unknown action' }) };
  }

  // ── Fetch current HTML from GitHub ─────────────────────────────────────────
  const ghBase = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const ghHeaders = {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'netlify-editor-function',
  };

  let currentHTML, fileSHA;
  try {
    const ghRes = await fetchWithRetry(ghBase, { headers: ghHeaders });
    if (!ghRes.ok) throw new Error(`GitHub fetch failed: ${ghRes.status} ${await ghRes.text()}`);
    const ghData = await ghRes.json();
    currentHTML = Buffer.from(ghData.content, 'base64').toString('utf8');
    fileSHA = ghData.sha;
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not fetch file from GitHub: ' + err.message }) };
  }

  // ── Undo: restore previous commit ─────────────────────────────────────────
  if (action === 'undo') {
    try {
      const commitsRes = await fetchWithRetry(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/commits?path=${GITHUB_FILE}&per_page=2`,
        { headers: ghHeaders }
      );
      const commits = await commitsRes.json();
      if (!commits[1]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No previous version to revert to.' }) };
      }
      const prevSHA = commits[1].sha;
      const prevFileRes = await fetchWithRetry(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${prevSHA}`,
        { headers: ghHeaders }
      );
      const prevFileData = await prevFileRes.json();
      const prevHTML = Buffer.from(prevFileData.content, 'base64').toString('utf8');

      const commitRes = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${GITHUB_FILE}`,
        {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'undo: revert to previous version',
            content: Buffer.from(prevHTML).toString('base64'),
            sha: fileSHA,
          }),
        }
      );
      if (!commitRes.ok) throw new Error(await commitRes.text());

      const contentMatch = prevHTML.match(/<!-- ═+\s*CONTENT[^═]*═+ -->([\s\S]*?)<!-- ═+\s*END CONTENT/);
      const newContent = contentMatch ? contentMatch[1].replace(/<div id="content">|<\/div>\s*$/g, '').trim() : '';

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, newContent }) };
    } catch (err) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Undo failed: ' + err.message }) };
    }
  }

  // ── Build conversation for Claude ──────────────────────────────────────────
  // Extract only the content section to keep context tight
  const contentMatch = currentHTML.match(/<!-- ═+\s*CONTENT[^─]*?─*\s*═+ -->([\s\S]*?)<!-- ═+\s*END CONTENT/);
  const contentSection = contentMatch ? contentMatch[1].trim() : currentHTML;

  const systemPrompt = `You are an HTML page editor assistant. The user will ask you to make changes to a webpage.

You will receive the current HTML inside <div id="content">...</div> and the user's instruction.

Rules:
1. Return ONLY the new inner HTML for the content div — no wrapper tags, no markdown, no code fences.
2. Preserve valid, accessible HTML.
3. Be creative but stay faithful to the user's request.
4. After the HTML, on a new line starting with "SUMMARY:", write one short sentence describing what you changed (this is shown to the user in the chat).

Format your response exactly like this:
<new inner html here>
SUMMARY: <one sentence describing the change>`;

  const messages = [
    // Replay condensed history (last 6 turns max to save tokens)
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: `Current content:\n${contentSection}\n\nInstruction: ${message}`,
    },
  ];

  // ── Call Claude API ────────────────────────────────────────────────────────
  let newContentHTML, summary;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content[0].text;

    // Split HTML from summary
    const summaryMatch = responseText.match(/\nSUMMARY:\s*(.+)$/m);
    summary = summaryMatch ? summaryMatch[1].trim() : 'Changes applied.';
    newContentHTML = responseText.replace(/\nSUMMARY:.*$/m, '').trim();
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude API error: ' + err.message }) };
  }

  // ── Splice new content into full HTML ─────────────────────────────────────
  const newFullHTML = currentHTML.replace(
    /(<!-- ═+\s*CONTENT[^─]*?─*\s*═+ -->)([\s\S]*?)(<!-- ═+\s*END CONTENT)/,
    `$1\n${newContentHTML}\n$3`
  );

  // ── Commit to GitHub ───────────────────────────────────────────────────────
  try {
    const commitRes = await fetch(ghBase, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `edit: ${message.substring(0, 72)}`,
        content: Buffer.from(newFullHTML).toString('base64'),
        sha: fileSHA,
      }),
    });

    if (!commitRes.ok) {
      const errText = await commitRes.text();
      throw new Error(`GitHub commit failed: ${commitRes.status} ${errText}`);
    }
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not commit to GitHub: ' + err.message }) };
  }

  // ── Return success ─────────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      summary,
      newContent: newContentHTML,
    }),
  };
};
