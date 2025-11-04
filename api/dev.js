// api/dev.js
// Simple Vercel serverless handler for AI dev assistant
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  const body = await (req.body || {});
  const prompt = body.prompt || '';
  if (!prompt || prompt.trim().length === 0) return res.status(400).json({ error: 'Empty prompt' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!OPENAI_KEY) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY env var' });

  const systemInstructions = `
You are an AI developer assistant for a Docsify documentation site. The user will ask you to produce or update files (Markdown, HTML, or JSON). 
- Output must be plain text with code blocks where appropriate.
- When giving file contents, wrap them in markdown triple-backticks with a filename header when possible.
- Do NOT attempt to directly modify the GitHub repo; instead return the exact file contents and a suggested commit message.
- Keep answers concise and give exact copy-pasteable text.
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1200,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Upstream error', details: text });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'No reply';
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
