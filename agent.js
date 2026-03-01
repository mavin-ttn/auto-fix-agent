#!/usr/bin/env node
/**
 * 🤖 Agentic Bug Fix AI
 * Flow: Jira Ticket → Read GitHub Codebase → GPT-4 Analyzes & Fixes → Create PR
 *
 * Setup:
 *   npm install openai @octokit/rest axios dotenv
 *   cp .env.example .env   # fill in your keys
 *   node agent.js <JIRA_TICKET_ID>
 *
 * Example:
 *   node agent.js BUG-42
 */

require("dotenv").config();
const OpenAI = require("openai");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");

// ─── Clients ────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: 'http://localhost:11434/' });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ─── Config ─────────────────────────────────────────────────────────────────
const config = {
  jira: {
    baseUrl: 'https://auto-fix-agent.atlassian.net/',       // e.g. https://yourcompany.atlassian.net
    email: 'sheikh.mavin@tothenew.com',  //https://id.atlassian.com/manage-profile/security/api-tokens
    apiToken: process.env.jira_token,
  },
  github: {
    owner: 'mavin-ttn', 
    repo: 'auto-fix-agent',            // repo name
    baseBranch: process.env.GITHUB_BASE_BRANCH || "main",
    codeFilePath: process.env.CODE_FILE_PATH || "index.js",
  },
  openai: {
    model: 'llama3.2',  // or "gpt-4-turbo"
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(step, total, msg) {
  console.log(`\n[${step}/${total}] ${msg}`);
}

function extractTextFromADF(adf) {
  if (!adf || !adf.content) return "No description provided.";
  const texts = [];
  function walk(node) {
    if (node.type === "text") texts.push(node.text);
    if (node.content) node.content.forEach(walk);
  }
  adf.content.forEach(walk);
  return texts.join(" ");
}

// ─── Step 1: Fetch Jira Ticket ───────────────────────────────────────────────
async function fetchJiraTicket(ticketId) {
  log(1, 5, `📋 Fetching Jira ticket: ${ticketId}`);

  const url = `${config.jira.baseUrl}/rest/api/3/issue/${ticketId}`;
  const auth = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64");

  const { data } = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });

  const { summary, description, priority, issuetype } = data.fields;
  const descriptionText = extractTextFromADF(description);

  console.log(`   ✅ Summary  : ${summary}`);
  console.log(`   ✅ Priority : ${priority?.name}`);
  console.log(`   ✅ Type     : ${issuetype?.name}`);

  return {
    ticketId,
    summary,
    description: descriptionText,
    priority: priority?.name,
    type: issuetype?.name,
  };
}

// ─── Step 2: Read File from GitHub ──────────────────────────────────────────
async function readCodebase() {
  log(2, 5, `📂 Reading ${config.github.codeFilePath} from GitHub`);

  const { data } = await octokit.repos.getContent({
    owner: config.github.owner,
    repo: config.github.repo,
    path: config.github.codeFilePath,
    ref: config.github.baseBranch,
  });

  const code = Buffer.from(data.content, "base64").toString("utf-8");

  console.log(`   ✅ Read ${code.split("\n").length} lines (sha: ${data.sha.slice(0, 8)}...)`);

  return { code, sha: data.sha };
}

// ─── Step 3: Analyze & Fix with GPT-4 ───────────────────────────────────────
async function analyzeAndFix(ticket, code) {
  log(3, 5, `🧠 Sending to GPT-4 (${config.openai.model}) for analysis...`);

  const systemPrompt = `You are a senior software engineer performing automated bug triage and repair.
You will be given a Jira bug ticket and the full source of a JavaScript file.
Your job is to:
1. Identify the exact bug described in the ticket.
2. Return the COMPLETE fixed file — every line, nothing omitted.
3. Write a clear pull-request description.

CRITICAL: Respond with ONLY a valid JSON object. No markdown, no code fences, no commentary.
Schema:
{
  "bugAnalysis": "<what is wrong and why>",
  "fixedCode": "<complete fixed file as a string>",
  "prTitle": "<concise title, include ticket ID>",
  "prDescription": "<markdown body: ## Summary, ## Root Cause, ## Fix, ## Testing>"
}`;

  const userMessage = `## Jira Ticket
ID: ${ticket.ticketId}
Summary: ${ticket.summary}
Priority: ${ticket.priority}
Description: ${ticket.description}

## Source File: ${config.github.codeFilePath}
\`\`\`javascript
${code}
\`\`\``;

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: "json_object" }, // GPT-4o / gpt-4-turbo support this
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  const result = JSON.parse(response.choices[0].message.content);

  console.log(`   ✅ Tokens used: ${response.usage.total_tokens}`);
  console.log(`   ✅ Bug found  : ${result.bugAnalysis.slice(0, 90)}...`);

  return result;
}

// ─── Step 4: Create Branch & Commit Fix ─────────────────────────────────────
async function pushFix(fixedCode, fileSha, ticket) {
  const branchName = `fix/${ticket.ticketId.toLowerCase()}-auto-fix`;
  log(4, 5, `🌿 Creating branch: ${branchName}`);

  // Get HEAD SHA of base branch
  const { data: ref } = await octokit.git.getRef({
    owner: config.github.owner,
    repo: config.github.repo,
    ref: `heads/${config.github.baseBranch}`,
  });

  // Create the new branch
  await octokit.git.createRef({
    owner: config.github.owner,
    repo: config.github.repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
  console.log(`   ✅ Branch created`);

  // Commit the fixed file onto the new branch
  await octokit.repos.createOrUpdateFileContents({
    owner: config.github.owner,
    repo: config.github.repo,
    path: config.github.codeFilePath,
    message: `fix(${ticket.ticketId}): ${ticket.summary}`,
    content: Buffer.from(fixedCode).toString("base64"),
    sha: fileSha,
    branch: branchName,
  });
  console.log(`   ✅ Fixed code committed`);

  return branchName;
}

// ─── Step 5: Open Pull Request ───────────────────────────────────────────────
async function openPullRequest(branchName, fix, ticket) {
  log(5, 5, `🚀 Opening Pull Request...`);

  const { data: pr } = await octokit.pulls.create({
    owner: config.github.owner,
    repo: config.github.repo,
    title: fix.prTitle,
    body: fix.prDescription,
    head: branchName,
    base: config.github.baseBranch,
  });

  // Best-effort: add labels (won't fail the run if labels don't exist)
  try {
    await octokit.issues.addLabels({
      owner: config.github.owner,
      repo: config.github.repo,
      issue_number: pr.number,
      labels: ["bug", "auto-fix"],
    });
  } catch (_) {
    console.log(`   ⚠️  Could not add labels (create 'bug' and 'auto-fix' labels in your repo)`);
  }

  console.log(`   ✅ PR #${pr.number} opened: ${pr.html_url}`);
  return pr;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const ticketId = process.argv[2];

  if (!ticketId) {
    console.error("❌  Usage: node agent.js <JIRA_TICKET_ID>\n   Example: node agent.js BUG-42");
    process.exit(1);
  }

  // Validate required env vars
  const required = [
    "OPENAI_API_KEY",
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing environment variables:\n   ${missing.join("\n   ")}`);
    console.error("\n   Copy .env.example → .env and fill in your keys.");
    process.exit(1);
  }

  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   🤖  Agentic Bug Fix AI  (GPT-4 + GitHub)   ║");
  console.log("╚═══════════════════════════════════════════════╝");

  try {
    const ticket            = await fetchJiraTicket(ticketId);
    const { code, sha }     = await readCodebase();
    const fix               = await analyzeAndFix(ticket, code);
    const branch            = await pushFix(fix.fixedCode, sha, ticket);
    const pr                = await openPullRequest(branch, fix, ticket);

    console.log("\n╔═══════════════════════════════════════════════╗");
    console.log("║                  ✅  Done!                    ║");
    console.log("╚═══════════════════════════════════════════════╝");
    console.log(`\n  PR URL    : ${pr.html_url}`);
    console.log(`  Branch    : ${branch}`);
    console.log(`  Bug found : ${fix.bugAnalysis.slice(0, 80)}...`);
  } catch (err) {
    console.error("\n❌  Agent failed:", err.message);
    // Surface API error details if available
    if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
    if (err.status) console.error("HTTP status:", err.status);
    process.exit(1);
  }
}

run();