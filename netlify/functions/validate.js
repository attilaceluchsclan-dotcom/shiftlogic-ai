// ShiftLogic AI — Validate Function
// Checks a generated report against the original technician notes.
// Flags unsupported claims and returns a cleaned report with substitutions.
//
// Pipeline position: step 3 of 4
//   classify.js → generate.js → validate.js → save-report.js
//
// Input:  { report_text, original_notes }
// Output: { valid, issues[], cleaned_report_text, unsupported_count }
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const ANTHROPIC_URL      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER      = '2023-06-01';
const VALIDATE_MODEL     = 'claude-haiku-4-5-20251001';
const VALIDATE_MAX_TOKENS = 2500;

// ── Validation prompt ──
// The model reads both the original notes and the generated report.
// For each claim in the report that cannot be supported by the notes,
// it replaces it with "[To be verified]" in the cleaned version.
const VALIDATE_SYSTEM = `You are a factual accuracy auditor for industrial maintenance reports.
Your job: compare a generated report against the original technician notes and fix any unsupported claims.

RULES:
1. A claim is SUPPORTED if it directly matches or is a reasonable professional paraphrase of the original notes.
2. A claim is UNSUPPORTED if it adds facts not present in the notes: invented equipment IDs, times, names, part numbers, downtime values, root causes, or actions.
3. Professional language transformation is ACCEPTABLE: "belt stopped" → "conveyor belt ceased operation".
4. Placeholder phrases already in the report ("Not specified", "To be verified", "Further inspection required") are ACCEPTABLE — do not flag them.
5. For each UNSUPPORTED claim found: replace it with "[To be verified]" in the cleaned version.
6. Do NOT change the report structure, section headers, or supported content.
7. Return ONLY valid JSON — no prose, no markdown, no code fences.

JSON schema:
{
  "unsupported_count": integer,
  "issues": [
    {
      "claim": "exact text from the report that is unsupported",
      "issue": "brief reason why it is not supported by the notes",
      "replacement": "[To be verified]"
    }
  ],
  "cleaned_report_text": "full report text with all unsupported claims replaced"
}

If there are no unsupported claims, return:
{
  "unsupported_count": 0,
  "issues": [],
  "cleaned_report_text": "<identical to input report_text>"
}`;

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return errRes(405, 'Method Not Allowed');

  // ── Environment check ──
  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) return errRes(500, 'Server configuration error: missing API key.');
  if (!SUPABASE_URL)      return errRes(500, 'Server configuration error: missing database URL.');

  // ── Auth: verify JWT ──
  const token = extractToken(event.headers);
  if (!token) return errRes(401, 'Authentication required. Please log in.');

  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '');
  if (!user) return errRes(401, 'Session expired or invalid. Please log in again.');

  // ── Parse request body ──
  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return errRes(400, 'Invalid JSON body.'); }

  const reportText    = (body.report_text    || '').trim();
  const originalNotes = (body.original_notes || '').trim();

  if (!reportText)    return errRes(400, 'report_text is required.');
  if (!originalNotes) return errRes(400, 'original_notes is required.');
  if (reportText.length > 10000) return errRes(400, 'report_text exceeds maximum length.');

  // Build user message: notes first, then report
  const userMessage = [
    '=== ORIGINAL TECHNICIAN NOTES ===',
    originalNotes.substring(0, 4000),
    '',
    '=== GENERATED REPORT TO VALIDATE ===',
    reportText.substring(0, 5000)
  ].join('\n');

  // ── Call Haiku ──
  let aiRes, aiData;
  try {
    aiRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VER
      },
      body: JSON.stringify({
        model: VALIDATE_MODEL,
        max_tokens: VALIDATE_MAX_TOKENS,
        system: VALIDATE_SYSTEM,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    aiData = await aiRes.json();
  } catch (e) {
    console.error('Validate fetch failed:', e.message);
    return errRes(502, 'Validation service unavailable: ' + e.message);
  }

  if (!aiRes.ok) {
    console.error('Validate API error:', aiRes.status, aiData);
    return errRes(aiRes.status, aiData?.error?.message || `Validation error (${aiRes.status})`);
  }

  const jsonStr = aiData.content?.[0]?.text;
  if (!jsonStr) return errRes(500, 'Empty validation response from AI.');

  let result;
  try {
    const cleaned = jsonStr.trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    result = JSON.parse(cleaned);
  } catch (e) {
    console.error('Validation parse failed. Raw:', jsonStr);
    // Non-fatal: if parse fails, return the original report as-is with a warning
    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        valid: false,
        parse_error: true,
        unsupported_count: 0,
        issues: [],
        cleaned_report_text: reportText,
        warning: 'Validation check could not be parsed. Original report returned.'
      })
    };
  }

  // Validate response structure
  if (typeof result.unsupported_count !== 'number') result.unsupported_count = 0;
  if (!Array.isArray(result.issues)) result.issues = [];
  if (!result.cleaned_report_text) result.cleaned_report_text = reportText;

  const valid = result.unsupported_count === 0;

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      valid,
      unsupported_count: result.unsupported_count,
      issues: result.issues,
      cleaned_report_text: result.cleaned_report_text
    })
  };
};

// ─────────────────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────────────────

async function verifyUser(token, url, anonKey) {
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? { id: user.id, email: user.email } : null;
}

// ─────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────

function extractToken(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function errRes(status, message) {
  return {
    statusCode: status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  };
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
