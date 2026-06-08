// ShiftLogic AI — Admin API Function
// Read-only dashboard data endpoint. Secured by ADMIN_SECRET env var.
// No npm required — uses native fetch (Node 18+).
//
// POST /.netlify/functions/admin
//   Headers: x-admin-secret: <ADMIN_SECRET>
//   Body:    { action: "stats" | "users" | "reports" }
//
// Required env vars:
//   ADMIN_SECRET       — any strong random string you choose
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors(),body:''};
  if(event.httpMethod !== 'POST')    return errRes(405,'Method Not Allowed');

  const {ADMIN_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY} = process.env;

  if(!ADMIN_SECRET){
    return errRes(500,'Admin not configured (ADMIN_SECRET missing).');
  }

  // ── Check admin secret ──
  const provided = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  if(!provided || provided !== ADMIN_SECRET){
    return errRes(403,'Forbidden.');
  }

  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY){
    return errRes(500,'Database not configured.');
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e){ return errRes(400,'Invalid JSON.'); }

  const action = body.action || 'stats';

  if(action === 'stats')   return getStats(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  if(action === 'users')   return getUsers(SUPABASE_URL, SUPABASE_SERVICE_KEY, body.limit || 100);
  if(action === 'reports') return getReports(SUPABASE_URL, SUPABASE_SERVICE_KEY, body.limit || 50);

  return errRes(400,'Unknown action. Use: stats, users, reports');
};

// ─────────────────────────────────────────────────────────
// STATS OVERVIEW
// ─────────────────────────────────────────────────────────
async function getStats(url, key){
  const [profilesRes, reportsRes, proRes] = await Promise.all([
    supaFetch(url, key, '/rest/v1/profiles?select=id,plan,reports_used,created_at&order=created_at.desc'),
    supaFetch(url, key, '/rest/v1/reports?select=id,report_type,created_at&order=created_at.desc&limit=1000'),
    supaFetch(url, key, '/rest/v1/profiles?plan=eq.pro&select=id')
  ]);

  const profiles = await profilesRes.json();
  const reports  = await reportsRes.json();
  const proUsers = await proRes.json();

  if(!Array.isArray(profiles)) return errRes(500, 'Failed to fetch profiles.');

  const totalUsers   = profiles.length;
  const totalReports = Array.isArray(reports) ? reports.length : 0;
  const proCount     = Array.isArray(proUsers) ? proUsers.length : 0;
  const totalUsage   = profiles.reduce((s,p) => s + (p.reports_used || 0), 0);
  const avgUsage     = totalUsers > 0 ? (totalUsage / totalUsers).toFixed(1) : 0;

  // Signups per day (last 7 days)
  const now   = new Date();
  const daily = {};
  for(let i=6; i>=0; i--){
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    daily[d.toISOString().slice(0,10)] = 0;
  }
  profiles.forEach(p => {
    const day = (p.created_at || '').slice(0,10);
    if(daily[day] !== undefined) daily[day]++;
  });

  // Report type breakdown
  const typeCounts = {};
  if(Array.isArray(reports)){
    reports.forEach(r => {
      const t = r.report_type || 'Unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
  }

  // Recent signups (last 10)
  const recentSignups = profiles.slice(0,10).map(p => ({
    created_at: p.created_at,
    plan: p.plan,
    reports_used: p.reports_used
  }));

  return okRes({
    totalUsers,
    totalReports,
    proCount,
    freeCount: totalUsers - proCount,
    totalUsage,
    avgUsage,
    dailySignups: daily,
    typeCounts,
    recentSignups
  });
}

// ─────────────────────────────────────────────────────────
// USER LIST
// ─────────────────────────────────────────────────────────
async function getUsers(url, key, limit){
  const res   = await supaFetch(url, key,
    `/rest/v1/profiles?select=id,name,plan,reports_used,stripe_customer_id,created_at&order=created_at.desc&limit=${limit}`
  );
  const users = await res.json();
  if(!Array.isArray(users)) return errRes(500,'Failed to fetch users.');
  return okRes({users, count: users.length});
}

// ─────────────────────────────────────────────────────────
// RECENT REPORTS
// ─────────────────────────────────────────────────────────
async function getReports(url, key, limit){
  const res     = await supaFetch(url, key,
    `/rest/v1/reports?select=id,user_id,report_type,site,shift,created_at&order=created_at.desc&limit=${limit}`
  );
  const reports = await res.json();
  if(!Array.isArray(reports)) return errRes(500,'Failed to fetch reports.');
  return okRes({reports, count: reports.length});
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function supaFetch(url, key, path){
  return fetch(url + path, {
    headers: {'apikey': key, 'Authorization': `Bearer ${key}`}
  });
}

function okRes(data){
  return {
    statusCode: 200,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:true, ...data})
  };
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
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
