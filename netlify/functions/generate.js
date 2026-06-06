// ShiftLogic AI — Generate Function (v3 — pipeline refactor)
// Pure AI generation step. Verifies JWT but does NOT save to DB or count usage.
// DB save and usage increment are handled by save-report.js.
//
// Pipeline position: step 2 of 4
//   classify.js → generate.js → validate.js → save-report.js
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER  = '2023-06-01';
const MAX_TOKENS_CAP = 2000;

// Compliance supplement — injected automatically for regulated industries
const COMPLIANCE_INDUSTRIES = new Set([
  'food & beverage', 'pharmaceutical', 'water treatment', 'aviation'
]);

const COMPLIANCE_SUPPLEMENT = `
CRITICAL COMPLIANCE SUPPLEMENT:
This report relates to a regulated industry. Apply the following rules:
- Always include a dedicated "SAFETY / COMPLIANCE IMPACT" section.
- Reference relevant standards (HACCP, GMP, FDA, WRAS, DWI, CAA) if evident in the notes.
- Preserve exact deviation numbers, batch numbers, lot numbers, and regulatory reference codes.
- If a product recall, regulatory notification, or deviation report may be required, state this clearly.
- Do not speculate on regulatory consequences beyond what the notes indicate.
`;

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

  if (!body.model || !Array.isArray(body.messages)) {
    return errRes(400, 'Request body must include model and messages array.');
  }
  if (!body.messages.length || !body.messages[0]?.content) {
    return errRes(400, 'messages array must contain at least one message with content.');
  }

  // Enforce token ceiling
  body.max_tokens = Math.min(body.max_tokens || 1500, MAX_TOKENS_CAP);

  // ── Inject classification context into the system prompt ──
  const classification = body.classification || null;
  delete body.classification;

  if (classification) {
    body.messages = injectClassificationContext(body.messages, classification);
  }

  // ── Strip any other custom metadata fields before sending to Anthropic ──
  delete body.metadata;

  // ── Call Anthropic ──
  let anthropicRes, anthropicData;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VER
      },
      body: JSON.stringify(body)
    });
    anthropicData = await anthropicRes.json();
  } catch (e) {
    console.error('Anthropic fetch failed:', e.message);
    return errRes(502, 'Failed to reach AI service: ' + e.message);
  }

  if (!anthropicRes.ok) {
    console.error('Anthropic API error:', anthropicRes.status, anthropicData);
    return errRes(
      anthropicRes.status,
      anthropicData?.error?.message || `AI service error (${anthropicRes.status})`
    );
  }

  const reportText = anthropicData.content?.[0]?.text;
  if (!reportText) return errRes(500, 'AI returned an empty response. Please try again.');

  // ── Return generated report to client — no DB save, no usage count ──
  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      report_text: reportText,
      usage: anthropicData.usage || {}
    })
  };
};

// ─────────────────────────────────────────────────────────
// CLASSIFICATION CONTEXT INJECTION
// ─────────────────────────────────────────────────────────

function injectClassificationContext(messages, classification) {
  const {
    industry,
    asset_type,
    report_type,
    fault_category,
    root_cause_status,
    safety_relevant
  } = classification;

  const lines = ['CLASSIFICATION CONTEXT (pre-determined by classification step):'];
  if (industry)          lines.push(`  Industry / Sector: ${industry}`);
  if (asset_type)        lines.push(`  Asset Type: ${asset_type}`);
  if (report_type)       lines.push(`  Report Type: ${report_type}`);
  if (fault_category)    lines.push(`  Fault Category: ${fault_category}`);
  if (root_cause_status) lines.push(`  Root Cause Status: ${root_cause_status.toUpperCase()}`);
  if (safety_relevant)   lines.push(`  Safety / Compliance Relevant: YES`);

  const contextBlock = lines.join('\n') + '\n\n';

  const industryLower = (industry || '').toLowerCase();
  const needsCompliance = COMPLIANCE_INDUSTRIES.has(industryLower) || safety_relevant;
  const supplement = needsCompliance ? COMPLIANCE_SUPPLEMENT + '\n' : '';

  const updated = [...messages];
  const firstMsg = { ...updated[0] };

  if (typeof firstMsg.content === 'string') {
    firstMsg.content = contextBlock + supplement + firstMsg.content;
  } else if (Array.isArray(firstMsg.content)) {
    const textBlock = firstMsg.content.find(b => b.type === 'text');
    if (textBlock) {
      textBlock.text = contextBlock + supplement + textBlock.text;
    }
  }

  updated[0] = firstMsg;
  return updated;
}

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
