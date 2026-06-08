// ShiftLogic AI — Share Report Function
// Generates a unique share token for a report and returns a shareable URL.
// If the report already has a token, returns the existing one.
// No npm required — uses native fetch + built-in crypto (Node 18+).
//
// POST /.netlify/functions/share-report
//   Body: { report_id: "uuid" }
//   Auth: Bearer JWT required
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_KEY

const crypto = require('crypto');

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors(),body:''};
  if(event.httpMethod !== 'POST')    return errRes(405,'Method Not Allowed');

  const {SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY} = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return errRes(500,'Server configuration error.');

  // ── Auth ──
  const token = extractToken(event.headers);
  if(!token) return errRes(401,'Authentication required.');
  const user = await verifyUser(token, SUPABASE_URL, SUPABASE_ANON_KEY || '');
  if(!user)  return errRes(401,'Session expired. Please log in again.');

  // ── Parse body ──
  let body;
  try { body = JSON.parse(event.body); } catch(e){ return errRes(400,'Invalid JSON.'); }
  const {report_id} = body;
  if(!report_id) return errRes(400,'report_id is required.');

  // ── Check report belongs to user ──
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(report_id)}&user_id=eq.${encodeURIComponent(user.id)}&select=id,share_token`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await checkRes.json();
  if(!Array.isArray(rows) || !rows[0]) return errRes(404,'Report not found.');

  const report = rows[0];

  // ── Return existing token or generate new one ──
  let shareToken = report.share_token;
  if(!shareToken){
    shareToken = crypto.randomBytes(20).toString('hex'); // 40-char hex
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(report_id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({share_token: shareToken})
      }
    );
    if(!updateRes.ok){
      console.error('Failed to save share token:', await updateRes.text());
      return errRes(500,'Failed to create share link.');
    }
  }

  const origin = (event.headers.origin || 'https://shiftlogic-ai.netlify.app').replace(/\/+$/,'');
  const shareUrl = `${origin}/?share=${shareToken}`;

  return {
    statusCode: 200,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:true, share_token: shareToken, share_url: shareUrl})
  };
};

async function verifyUser(token, url, anonKey){
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers:{'apikey':anonKey,'Authorization':`Bearer ${token}`}
    });
    if(!res.ok) return null;
    const u = await res.json();
    return u && u.id ? {id:u.id} : null;
  } catch(e){ return null; }
}

function extractToken(headers){
  const auth = headers['authorization'] || headers['Authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function errRes(status, message){
  return {
    statusCode: status,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:false, error:message})
  };
}

function cors(){
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
