const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 3000);
const repository = process.env.GITHUB_REPOSITORY || 'rameshhugar184-design/FirstProject';
const apiBase = `https://api.github.com/repos/${repository}`;
const supportedCategories = ['server_not_responding', 'data_not_available'];
const marker = '<!-- firstproject-issue-triage -->';

function splitList(value) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function githubHeaders(extra = {}) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not configured');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: githubHeaders(options.headers || {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && data.message ? data.message : response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return data;
}

function classifyIssue(title = '', body = '') {
  const text = `${title}\n${body}`.toLowerCase();
  if (/server.{0,30}(not responding|no response|unresponsive)|(?:not responding|no response|unresponsive).{0,30}server/.test(text)) {
    return 'server_not_responding';
  }
  if (/data.{0,30}(not available|unavailable|missing)|(?:not available|unavailable|missing).{0,30}data/.test(text)) {
    return 'data_not_available';
  }
  return null;
}

function categoryConfig(category) {
  if (category === 'server_not_responding') {
    return {
      label: 'server-not-responding',
      team: process.env.L2_SUPPORT_TEAM_MENTION,
      assignees: splitList(process.env.L2_SUPPORT_ASSIGNEES),
      display: 'Server not responding',
    };
  }
  if (category === 'data_not_available') {
    return {
      label: 'data-not-available',
      team: process.env.TECH_TEAM_MENTION,
      assignees: splitList(process.env.TECH_TEAM_ASSIGNEES),
      display: 'Data not available',
    };
  }
  return { label: 'needs-triage', team: '', assignees: [], display: 'Uncategorized issue' };
}

function getSolutions() {
  const file = path.join(__dirname, 'solutions.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Unable to read src/solutions.json:', error.message);
    return {};
  }
}

async function ensureLabel(name, color, description) {
  try {
    await githubRequest(`${apiBase}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color, description }),
    });
  } catch (error) {
    // GitHub returns 422 when the label already exists. Other errors should be reported.
    if (!error.message.startsWith('GitHub API 422:')) throw error;
  }
}

async function addLabels(issueNumber, labels) {
  for (const label of labels) await ensureLabel(label.name, label.color, label.description);
  await githubRequest(`${apiBase}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: labels.map((label) => label.name) }),
  });
}

async function postComment(issueNumber, message) {
  await githubRequest(`${apiBase}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `${marker}\n${message}` }),
  });
}

async function triageIssue(issue) {
  const category = classifyIssue(issue.title, issue.body);
  const routing = categoryConfig(category);
  const labels = [{ name: routing.label, color: '1d76db', description: `Issue category: ${routing.display}` }];
  const solutions = getSolutions();
  const steps = category && Array.isArray(solutions[category]) ? solutions[category] : [];
  let comment;

  if (steps.length) {
    comment = `### Suggested resolution steps\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nPlease confirm whether these steps resolve the issue.`;
  } else {
    labels.push({ name: 'human-action-required', color: 'd93f0b', description: 'No verified resolution is configured; human investigation is required.' });
    const teamLine = routing.team ? `\n\nRequested team: ${routing.team}` : '';
    comment = `### Human action required\n\nNo verified solution is configured for **${routing.display}**. Please investigate and document the resolution before adding it to \\`src/solutions.json\\`.${teamLine}`;
  }

  await addLabels(issue.number, labels);
  if (routing.assignees.length) {
    await githubRequest(`${apiBase}/issues/${issue.number}/assignees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignees: routing.assignees }),
    });
  }

  // Do not create duplicate triage comments when GitHub retries a webhook delivery.
  const comments = await githubRequest(`${apiBase}/issues/${issue.number}/comments?per_page=100`);
  if (!comments.some((existing) => (existing.body || '').includes(marker))) {
    await postComment(issue.number, comment);
  }
}

function validWebhookSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const supplied = req.get('x-hub-signature-256') || '';
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/issues', express.json({ limit: '1mb' }), async (req, res) => {
  const expectedKey = process.env.API_KEY;
  const authorization = req.get('authorization') || '';
  if (!expectedKey || authorization !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { title, body = '', labels = [] } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (typeof body !== 'string' || !Array.isArray(labels) || !labels.every((label) => typeof label === 'string')) {
    return res.status(400).json({ error: 'body must be a string and labels must be an array of strings' });
  }
  try {
    const issue = await githubRequest(`${apiBase}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), body, labels }),
    });
    return res.status(201).json({ number: issue.number, url: issue.html_url, title: issue.title });
  } catch (error) {
    console.error('Issue creation failed:', error.message);
    return res.status(502).json({ error: 'Unable to create GitHub issue' });
  }
});

// Keep the raw request body for HMAC verification; do not parse it before checking the signature.
app.post('/webhooks/github', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!validWebhookSignature(req)) return res.status(401).send('Invalid webhook signature');
  if (req.get('x-github-event') !== 'issues') return res.status(202).send('Event ignored');
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
  if (payload.repository?.full_name !== repository) return res.status(202).send('Repository ignored');
  if (payload.action !== 'opened' || !payload.issue) return res.status(202).send('Action ignored');
  try {
    await triageIssue(payload.issue);
    return res.status(200).send('Issue triaged');
  } catch (error) {
    console.error(`Triage failed for issue #${payload.issue.number}:`, error.message);
    return res.status(500).send('Issue triage failed');
  }
});

app.listen(port, () => console.log(`Issue API listening on port ${port}; repository=${repository}`));
