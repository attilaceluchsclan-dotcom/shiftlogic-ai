// ShiftLogic AI — Reports Function
// Returns report history for the authenticated user.
// No npm packages required — uses native fetch (Node 18+).
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_KEY
//
// Endpoints:
//   GET  /.netlify/functions/reports              → last 50 reports for user
//   GET  /.netlify/functions/reports?id=<uuid>    → single report by ID
//   DELETE /.netlify/functions/reports?id=<uuid>  → soft-delete a report

const DEFAULT_LIMIT = 50;

exports.handler = async function(event) {
  // CORS preflight
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers: cors(), body: '' };
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY){
    return errRes(500, 'Server configuration error.');
  }

  // Auth
  const token = extractToken(event.headers);
  if(!token) return errRes(401, 'Authentication required. Please log in.');

  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '', SUPABASE_SERVICE_KEY);
  if(!user) return errRes(401, 'Session expired or invalid. Please log in again.');

  const reportId = event.queryStringParameters?.id || null;

  // ── GET single report ──
  if(event.httpMethod === 'GET' && reportId){
    return getSingleReport(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id, reportId);
  }

  // ── GET report list ──
  if(event.httpMethod === 'GET'){
    const limit  = parseInt(event.queryStringParameters?.limit  || String(DEFAULT_LIMIT));
    const offset = parseInt(event.queryStringParameters?.offset || '0');
    return getReports(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id, limit, offset);
  }

  // ── DELETE report ──
  if(event.httpMethod === 'DELETE' && reportId){
    return deleteReport(SUPABASE_URL, SUPABASE_SERVICE_KEY, user.id, reportId);
  }

  return errRes(405, 'Method Not Allowed');
};

// ─────────────────────────────────────────────────────────
// REPORT HANDLERS
// ─────────────────────────────────────────────────────────

async function getReports(url, serviceKey, userId, limit, offset){
  // Fetch reports owned by this user, newest first
  // Exclude report_text to keep payload small — load full text on demand
  const params = new URLSearchParams({
    user_id:  `eq.${userId}`,
    deleted:  'eq.false',
    select:   'id,report_type,site,shift,technician,created_at,input_tokens,output_tokens',
    order:    'created_at.desc',
    limit:    String(Math.min(limit, 100)),
    offset:   String(offset)
  });

  const res = await fetch(`${url}/rest/v1/reports?${params}`, {
    headers: supabaseHeaders(serviceKey)
  });

  if(!res.ok){
    const text = await res.text();
    console.error('getReports failed:', res.status, text);
    return errRes(500, 'Failed to load report history.');
  }

  const reports = await res.json();

  // Also get total count for pagination
  const countRes = await fetch(
    `${url}/rest/v1/reports?user_id=eq.${userId}&deleted=eq.false&select=id`,
    {
      headers: {
        ...supabaseHeaders(serviceKey),
        'Prefer': 'count=exact',
        'Range-Unit': 'items',
        'Range': '0-0'
      }
    }
  );

  const contentRange = countRes.headers?.get('Content-Range') || '';
  const total = parseInt(contentRange.split('/')[1] || '0') || reports.length;

  return okRes({ reports, total, limit, offset });
}

async function getSingleReport(url, serviceKey, userId, reportId){
  // Fetch full report including report_text — only if owned by user
  const params = new URLSearchParams({
    id:      `eq.${reportId}`,
    user_id: `eq.${userId}`,
    deleted: 'eq.false',
    select:  '*'
  });

  const res = await fetch(`${url}/rest/v1/reports?${params}`, {
    headers: supabaseHeaders(serviceKey)
  });

  if(!res.ok){
    const text = await res.text();
    console.error('getSingleReport failed:', res.status, text);
    return errRes(500, 'Failed to load report.');
  }

  const rows = await res.json();
  if(!rows || rows.length === 0) return errRes(404, 'Report not found.');

  return okRes({ report: rows[0] });
}

async function deleteReport(url, serviceKey, userId, reportId){
  // Soft delete — set deleted = true (requires deleted column in reports table)
  // Only deletes if the row belongs to this user
  const res = await fetch(
    `${url}/rest/v1/reports?id=eq.${reportId}&user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        ...supabaseHeaders(serviceKey),
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ deleted: true })
    }
  );

  if(!res.ok){
    const text = await res.text();
    console.error('deleteReport failed:', res.status, text);
    return errRes(500, 'Failed to delete report.');
  }

  return okRes({ deleted: true });
}

// ─────────────────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────────────────
async function verifyUser(token, url, anonKey, serviceKey){
  const authRes = await fetch(`${url}/auth/v1/user`, {
    headers: {
      'apikey': anonKey,
      'Authorization': `Bearer ${token}`
    }
  });
  if(!authRes.ok) return null;

  const authUser = await authRes.json();
  if(!authUser?.id) return null;

  return { id: authUser.id, email: authUser.email };
}

// ─────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────
function supabaseHeaders(serviceKey){
  return {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };
}

function extractToken(headers){
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if(auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function okRes(data){
  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, ...data })
  };
}

function errRes(status, message){
  return {
    statusCode: status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  };
}

function cors(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS'
  };
}
