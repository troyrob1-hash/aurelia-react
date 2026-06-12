exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify env' }) }
  }
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: event.body,
    })
    const text = await resp.text()
    return { statusCode: resp.status, headers: { 'Content-Type': 'application/json' }, body: text }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Proxy failed' }) }
  }
}
