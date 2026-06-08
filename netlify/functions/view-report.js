// ShiftLogic AI — View Report (Public) Function
// Returns a report by its share token — no authentication required.
// Used for shareable report links.
// No npm required — uses native fetch (Node 18+).
//
// GET /.netlify/functions/view-report?token=<share_token>
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors(),body:''};
  if(event.httpMethod !== 'GET')     return errRes(405,'Method Not Allowed');

  const {SUPABASE_URL, SUPABASE_SERVICE_KEY} = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return errRes(500,'Server configuration error.');

  const shareToken = event.queryStringParameters?.token;
  if(!shareToken) return errRes(400,'Share token is required.');

  // Sanitise token — only allow hex chars
  if(!/^[a-f0-9]{20,80}$/.test(shareToken)){
    return errRes(400,'Invalid share token.');
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/reports?share_token=eq.${encodeURIComponent(shareToken)}&select=id,report_type,report_text,created_at,site,shift,technician,industry,asset_name`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );

  const rows = await res.json();
  if(!Array.isArray(rows) || !rows[0]){
    return errRes(404,'Report not found or link has expired.');
  }

  const report = rows[0];

  return {
    statusCode: 200,
    headers: Object.assign(cors(), {'Content-Type':'application/json'}),
    body: JSON.stringify({success:true, report})
  };
};

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}
