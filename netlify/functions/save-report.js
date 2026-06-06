// ShiftLogic AI — Save Report Function
// The only endpoint that counts toward usage limits.
// Enforces server-side usage limit, saves report + classification + validation result,
// increments usage, and triggers non-blocking metadata extraction.
//
// Pipeline position: step 4 of 4
//   classify.js → generate.js → validate.js → save-report.js
//
// Required env vars:
//   ANTHROPIC_API_KEY     (for metadata extraction)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_KEY
//   FREE_REPORT_LIMIT     (optional, defaults to 5)

const ANTHROPIC_URL       = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER       = '2023-06-01';
const METADATA_MODEL      = 'claude-haiku-4-5-20251001';
const METADATA_MAX_TOKENS = 600;
const DEFAULT_FREE_LIMIT  = 5;
const PIPELINE_VERSION    = 'v3';

const METADATA_EXTRACTION_PROMPT = `Extract structured metadata from this industrial maintenance report. Return ONLY valid JSON — no prose, no markdown, no code fences.

JSON schema:
{
  "industry": "detected industry sector or null",
  "asset_type": "type of equipment/asset",
  "machine_or_system": "specific machine/system name or ID if stated, else null",
  "fault_category": "brief category of fault or event",
  "symptoms": ["array of observed symptoms"],
  "suspected_cause": "suspected cause or null",
  "confirmed_root_cause": "confirmed root cause or null",
  "root_cause_status": "confirmed|suspected|unknown",
  "actions_taken": ["array of actions taken"],
  "downtime_minutes": null,
  "operative_impact": "brief operational impact description",
  "safety_impact": "safety or compliance impact or null",
  "follow_up_actions": ["array of follow-up items"],
  "keywords": ["array of key technical terms from the report — max 15"]
}

Report:
`;

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return errRes(405, 'Method Not Allowed');

  // ── Environment check ──
  const {
    ANTHROPIC_API_KEY,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_KEY,
    FREE_REPORT_LIMIT
  } = process.env;

  if (!ANTHROPIC_API_KEY)    return errRes(500, 'Server configuration error: missing API key.');
  if (!SUPABASE_URL)         return errRes(500, 'Server configuration error: missing database URL.');
  if (!SUPABASE_SERVICE_KEY) return errRes(500, 'Server configuration error: missing service key.');

  const FREE_LIMIT = parseInt(FREE_REPORT_LIMIT || String(DEFAULT_FREE_LIMIT));

  // ── Auth: verify JWT and fetch user profile ──
  const token = extractToken(event.headers);
  if (!token) return errRes(401, 'Authentication required. Please log in.');

  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '', SUPABASE_SERVICE_KEY);
  if (!user) return errRes(401, 'Session expired or invalid. Please log in again.');

  // ── Usage limit — server-side enforcement ──
  if (user.plan === 'free' && user.reports_used >= FREE_LIMIT) {
    return errRes(403, `Free trial limit of ${FREE_LIMIT} reports reached. Please upgrade to Pro.`);
  }

  // ── Parse request body ──
  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return errRes(400, 'Invalid JSON body.'); }

  const {
    report_text,
    raw_notes,
    classification,
    validation_result,
    context = {}
  } = body;

  if (!report_text)    return errRes(400, 'report_text is required.');
  if (!raw_notes)      return errRes(400, 'raw_notes is required.');

  // ── Save report to DB ──
  let reportId = null;
  try {
    reportId = await saveReport(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      user_id:          user.id,
      report_type:      classification?.report_type || 'Unknown',
      raw_notes:        String(raw_notes).substring(0, 5000),
      report_text:      String(report_text),
      site:             context.site          || null,
      shift:            context.shift         || null,
      technician:       context.technician    || null,
      classification:   classification        || null,
      validation_result: validation_result    || null,
      pipeline_version: PIPELINE_VERSION,
      input_tokens:     body.usage?.input_tokens  || 0,
      output_tokens:    body.usage?.output_tokens || 0
    });
  } catch (e) {
    console.error('Report save failed:', e.message);
    return errRes(500, 'Failed to save report: ' + e.message);
  }

  // ── Non-blocking metadata extraction ──
  if (reportId) {
    extractAndSaveMetadata(
      ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, reportId, report_text
    ).catch(() => {});
  }

  // ── Increment usage count (atomic via Supabase RPC) ──
  let newUsageCount = user.reports_used + 1;
  try {
    const updated = await incrementUsage(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id);
    if (updated !== null) newUsageCount = updated;
  } catch (e) {
    console.error('Usage increment failed:', e.message);
  }

  // ── Return to client ──
  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      reportId,
      reportsUsed: newUsageCount
    })
  };
};

// ─────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────

async function verifyUser(token, url, anonKey, serviceKey) {
  // Verify token with Supabase Auth
  const authRes = await fetch(`${url}/auth/v1/user`, {
    headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
  });
  if (!authRes.ok) return null;

  const authUser = await authRes.json();
  if (!authUser?.id) return null;

  // Fetch profile
  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${authUser.id}&select=plan,reports_used`,
    { headers: supabaseHeaders(serviceKey) }
  );

  const profiles = await profRes.json();
  const profile  = Array.isArray(profiles) && profiles[0]
    ? profiles[0]
    : { plan: 'free', reports_used: 0 };

  return {
    id:           authUser.id,
    email:        authUser.email,
    plan:         profile.plan         || 'free',
    reports_used: profile.reports_used || 0
  };
}

async function saveReport(url, serviceKey, data) {
  const res = await fetch(`${url}/rest/v1/reports`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(serviceKey),
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB insert failed (${res.status}): ${text}`);
  }

  const rows = await res.json();
  return rows[0]?.id || null;
}

async function incrementUsage(url, serviceKey, userId) {
  // Try atomic RPC first
  const rpcRes = await fetch(`${url}/rest/v1/rpc/increment_usage`, {
    method: 'POST',
    headers: supabaseHeaders(serviceKey),
    body: JSON.stringify({ uid: userId })
  });

  if (rpcRes.ok) {
    return await rpcRes.json();
  }

  // Fallback: read-then-write
  console.warn('RPC increment_usage not available, using fallback');
  const readRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${userId}&select=reports_used`,
    { headers: supabaseHeaders(serviceKey) }
  );
  const rows    = await readRes.json();
  const current = rows[0]?.reports_used || 0;
  const next    = current + 1;

  await fetch(`${url}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: supabaseHeaders(serviceKey),
    body: JSON.stringify({ reports_used: next })
  });

  return next;
}

// ─────────────────────────────────────────────────────────
// METADATA EXTRACTION (non-blocking, fire-and-forget)
// ─────────────────────────────────────────────────────────

async function extractAndSaveMetadata(apiKey, supabaseUrl, serviceKey, reportId, reportText) {
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VER
      },
      body: JSON.stringify({
        model: METADATA_MODEL,
        max_tokens: METADATA_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: METADATA_EXTRACTION_PROMPT + reportText.substring(0, 3000)
        }]
      })
    });

    if (!res.ok) return;

    const data    = await res.json();
    const jsonStr = data.content?.[0]?.text;
    if (!jsonStr) return;

    const cleaned  = jsonStr.trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    const metadata = JSON.parse(cleaned);

    await fetch(`${supabaseUrl}/rest/v1/reports?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: {
        ...supabaseHeaders(serviceKey),
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ metadata })
    });
  } catch (e) {
    console.warn('Metadata extraction failed (non-fatal):', e.message);
  }
}

// ─────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────

function supabaseHeaders(serviceKey) {
  return {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
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
