// api/update.js
// Vercel serverless function: generate file edits via OpenAI and optionally commit them to GitHub (create PR).
// Required env vars (set in Vercel Settings -> Environment Variables):
// - OPENAI_API_KEY   (your OpenAI secret key)
// - GITHUB_TOKEN     (GitHub PAT with repo scope, stored securely)
// - REPO_OWNER       (github username or org owning the repo, e.g. "yourname")
// - REPO_NAME        (repository name, e.g. "cafe-docs")
// - TARGET_BRANCH    (optional, default "main")

const OK = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const ERR = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function callOpenAI(prompt) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY env var");

  // We instruct the model to return JSON with an array of files:
  // { "files": [ { "path": "docs/recipes/smoothie.md", "content": "## ...", "commitMessage": "Add smoothie recipe" }, ... ], "prTitle": "Add ..." }
  const system = `You are an assistant that outputs EXACT JSON only. The user will ask for file changes to a Docsify documentation repo.
Return a JSON object with:
{
  "files": [
    {
      "path": "<relative/path/to/file.md>",
      "content": "<file contents as text, no extra wrapping>",
      "commitMessage": "<short commit message for this file>"
    },
    ...
  ],
  "prTitle": "<one-line PR title>",
  "prBody": "<short PR description>"
}
Important: Return valid JSON and nothing else. Use multiple files when appropriate.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      max_tokens: 1800,
      temperature: 0.15
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${txt}`);
  }

  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no content");

  // Try to parse JSON. The model should return pure JSON.
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) {
    // Sometimes the model wraps with markdown fences or extra commentary. Try to extract JSON substring.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        throw new Error("Failed to parse JSON from model output. Raw output: " + text.substring(0, 1000));
      }
    }
    throw new Error("Failed to parse JSON from model output. Raw output: " + text.substring(0, 1000));
  }
}

async function createBranchAndCommitFiles({ owner, repo, targetBranch, files, prTitle, prBody, githubToken }) {
  // 1) Get ref of target branch
  const headers = {
    Authorization: `token ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // get default branch commit sha
  const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoResp.ok) {
    const txt = await repoResp.text();
    throw new Error(`GitHub repo lookup failed: ${repoResp.status} ${txt}`);
  }
  const repoInfo = await repoResp.json();
  const defaultBranch = targetBranch || repoInfo.default_branch || "main";

  // get latest commit on base branch
  const refResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refResp.ok) {
    const txt = await refResp.text();
    throw new Error(`Failed to fetch branch ref: ${refResp.status} ${txt}`);
  }
  const refJson = await refResp.json();
  const baseSha = refJson.object.sha;

  // create new branch name
  const time = Date.now();
  const newBranch = `ai-edit-${time}`;

  // create ref
  const createRefResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: baseSha })
  });
  if (!createRefResp.ok) {
    const txt = await createRefResp.text();
    throw new Error(`Failed to create branch: ${createRefResp.status} ${txt}`);
  }

  // For each file, use "create or update file contents" endpoint (simpler)
  for (const file of files) {
    const path = file.path;
    const message = file.commitMessage || prTitle || "AI edit";
    const contentEncoded = Buffer.from(file.content, "utf8").toString("base64");

    // Check if file exists to determine PUT payload (create vs update)
    const getFileResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${newBranch}`, { headers });
    let existingSha = null;
    if (getFileResp.ok) {
      const existing = await getFileResp.json();
      existingSha = existing.sha;
    } // if 404, file does not exist => create

    const putBody = {
      message,
      content: contentEncoded,
      branch: newBranch
    };
    if (existingSha) putBody.sha = existingSha;

    const putResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody)
    });

    if (!putResp.ok) {
      const txt = await putResp.text();
      throw new Error(`Failed to create/update file ${path}: ${putResp.status} ${txt}`);
    }
  }

  // Create PR
  const prResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: prTitle || "AI suggested edits",
      head: newBranch,
      base: defaultBranch,
      body: prBody || "AI-generated changes. Please review."
    })
  });

  if (!prResp.ok) {
    const txt = await prResp.text();
    throw new Error(`Failed to create PR: ${prResp.status} ${txt}`);
  }

  const prJson = await prResp.json();
  return prJson;
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") return ERR(405, { error: "Only POST allowed" });

    const body = await req.json().catch(() => ({}));
    const prompt = body.prompt; // user natural-language request
    const filesFromClient = body.files; // optional: pre-populated files array
    const approve = !!body.approve; // whether to actually write to GitHub
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const githubToken = process.env.GITHUB_TOKEN;
    const targetBranch = process.env.TARGET_BRANCH || undefined;

    if (!owner || !repo) return ERR(500, { error: "Server misconfigured: REPO_OWNER or REPO_NAME missing" });
    if (!process.env.OPENAI_API_KEY) return ERR(500, { error: "Server misconfigured: OPENAI_API_KEY missing" });

    // If client provided files directly (after AI preview), use them. Otherwise call OpenAI to generate.
    let aiResult;
    if (Array.isArray(filesFromClient) && filesFromClient.length > 0) {
      aiResult = {
        files: filesFromClient,
        prTitle: body.prTitle || "AI suggested edits",
        prBody: body.prBody || "AI suggested changes"
      };
    } else {
      if (!prompt) return ERR(400, { error: "No prompt provided" });
      // Ask OpenAI to generate JSON describing the file edits
      aiResult = await callOpenAI(prompt);
      if (!aiResult || !aiResult.files) return ERR(502, { error: "OpenAI returned no files. Raw: " + JSON.stringify(aiResult).substring(0, 1000) });
    }

    // If not approved, return the aiResult to the client so user can preview.
    if (!approve) {
      return OK({ preview: true, aiResult });
    }

    // approve=true -> perform GitHub operations. Ensure token exists.
    if (!githubToken) return ERR(500, { error: "Server missing GITHUB_TOKEN env var" });

    // Validate aiResult.files format
    if (!Array.isArray(aiResult.files) || aiResult.files.length === 0) {
      return ERR(400, { error: "No files to commit" });
    }

    // Commit files and open PR
    const pr = await createBranchAndCommitFiles({
      owner,
      repo,
      targetBranch,
      files: aiResult.files,
      prTitle: aiResult.prTitle,
      prBody: aiResult.prBody,
      githubToken
    });

    return OK({ success: true, pr });
  } catch (err) {
    console.error("api/update error:", err);
    return ERR(500, { error: err.message || String(err) });
  }
}
