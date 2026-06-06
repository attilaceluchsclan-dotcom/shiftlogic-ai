// ShiftLogic AI — Classify Function
// Lightweight Haiku call that classifies technician notes before report generation.
// Returns: industry, asset_type, report_type, fault_category, root_cause_status,
//          safety_relevant, confidence
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const ANTHROPIC_URL      = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER      = '2023-06-01';
const CLASSIFY_MODEL     = 'claude-haiku-4-5-20251001';
const CLASSIFY_MAX_TOKENS = 400;

const CLASSIFY_PROMPT = `You are a classification engine for industrial maintenance reports.
Analyse the technician notes below and return ONLY valid JSON — no prose, no markdown, no code fences.

Supported industries (choose the closest match or null):
Logistics, Manufacturing, Food & Beverage, Automotive, Facilities, Construction,
Energy, HVAC, Aviation, Fleet, Pharmaceutical, Water Treatment, Packaging, Mining, Data Centre

Supported report types (choose the most appropriate):
Fault / Breakdown Report, Preventive Maintenance Report, Shift Handover Report,
Daily Operations Summary, Safety Incident Report, Environmental / Spill Report,
Downtime Analysis Report, Work Order Completion Report, Root Cause Analysis,
Contractor / Visitor Log, Equipment Inspection Report, System Performance Report,
End-of-Shift Summary

Fault categories (choose the primary category, or null for non-fault tasks):
Mechanical Failure, Electrical Fault, Control / PLC Fault, Sensor / Instrumentation,
Pneumatics / Hydraulics, Refrigerant / Thermal, Contamination / Hygiene,
Structural / Civil, Power Event, Planned Maintenance, Operator Error,
Software / Firmware, Safety System, Environmental, Unknown / Under Investigation

Root cause status rules:
- "confirmed"  — root cause stated in notes AND a fix was performed and verified
- "suspected"  — evidence suggests a likely cause but not fully verified or fixed
- "unknown"    — cause is unclear or not mentioned in the notes

Safety relevance: true if notes mention injury risk, near-miss, e-stop, emergency,
chemical/biological hazard, fire, regulatory compliance concern, or product safety.

JSON schema — return exactly this structure:
{
  "industry": "string from supported list or null",
  "asset_type": "brief equipment/asset type (max 5 words)",
  "report_type": "string from supported list",
  "fault_category": "string from supported list or null",
  "root_cause_status": "confirmed|suspected|unknown",
  "safety_relevant": true/false,
  "confidence": "high|medium|low"
}

Notes to classify:
`;

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return errRes(405, 'Method Not Allowed');

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) return errRes(500, 'Server configuration error: missing API key.');
  if (!SUPABASE_URL)      return errRes(500, 'Server configuration error: missing database URL.');

  // ── Auth ──
  const token = extractToken(event.headers);
  if (!token) return errRes(401, 'Authentication required. Please log in.');

  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '');
  if (!user) return errRes(401, 'Session expired or invalid. Please log in again.');

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return errRes(400, 'Invalid JSON body.'); }

  const notes = (body.notes || '').trim();
  if (!notes || notes.length < 5) {
    return errRes(400, 'Notes are too short to classify (minimum 5 characters).');
  }
  if (notes.length > 8000) {
    return errRes(400, 'Notes exceed maximum length of 8000 characters.');
  }

  // Build prompt — append optional UI hints as tiebreakers
  let prompt = CLASSIFY_PROMPT + notes.substring(0, 3000);
  const hint = body.hint || {};
  if (hint.industry || hint.report_type) {
    prompt += '\n\nUser-provided context hints (use as tiebreaker if classification is ambiguous):';
    if (hint.industry)     prompt += `\nIndustry hint: ${hint.industry}`;
    if (hint.report_type)  prompt += `\nReport type hint: ${hint.report_type}`;
  }

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
        model: CLASSIFY_MODEL,
        max_tokens: CLASSIFY_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    aiData = await aiRes.json();
  } catch (e) {
    console.error('Classify fetch failed:', e.message);
    return errRes(502, 'Classification service unavailable: ' + e.message);
  }

  if (!aiRes.ok) {
    console.error('Classify API error:', aiRes.status, aiData);
    return errRes(aiRes.status, aiData?.error?.message || `Classification error (${aiRes.status})`);
  }

  const jsonStr = aiData.content?.[0]?.text;
  if (!jsonStr) return errRes(500, 'Empty classification response from AI.');

  let classification;
  try {
    // Strip accidental markdown fences
    const cleaned = jsonStr.trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    classification = JSON.parse(cleaned);
  } catch (e) {
    console.error('Classification parse failed. Raw response:', jsonStr);
    return errRes(500, 'Failed to parse classification response. Please try again.');
  }

  // Validate required fields — prevent malformed output reaching the client
  const required = ['industry', 'asset_type', 'report_type', 'root_cause_status',
                    'safety_relevant', 'confidence'];
  for (const field of required) {
    if (!(field in classification)) {
      console.error('Classification missing field:', field, classification);
      return errRes(500, `Classification response missing required field: ${field}`);
    }
  }

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, classification })
  };
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

async function verifyUser(token, url, anonKey) {
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? { id: user.id, email: user.email } : null;
}

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
