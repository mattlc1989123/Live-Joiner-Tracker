/**
 * /api/data — Live Joiner Tracker
 * Vercel serverless function. Queries Tableau on every page load.
 *
 * Set in Vercel → Settings → Environment Variables:
 *   TABLEAU_HOST        https://prod-uk-a.online.tableau.com
 *   TABLEAU_SITE        fitnessfirst
 *   TABLEAU_PAT_NAME    your PAT name
 *   TABLEAU_PAT_SECRET  your PAT secret
 *   TABLEAU_DS_LUID     53db3dc3-978a-461b-95c6-f02c6e6d2bd9
 */

const HOST    = (process.env.TABLEAU_HOST || '').replace(/\/$/, '');
const SITE    = process.env.TABLEAU_SITE || '';
const PAT     = process.env.TABLEAU_PAT_NAME || '';
const SECRET  = process.env.TABLEAU_PAT_SECRET || '';
const DS_LUID = process.env.TABLEAU_DS_LUID || '53db3dc3-978a-461b-95c6-f02c6e6d2bd9';

const MONTH_FILTER = {
  field: { fieldCaption: 'Date ' },
  filterType: 'DATE',
  periodType: 'MONTHS',
  dateRangeType: 'CURRENT'
};

async function auth() {
  const res = await fetch(`${HOST}/api/3.21/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      credentials: {
        personalAccessTokenName: PAT,
        personalAccessTokenSecret: SECRET,
        site: { contentUrl: SITE }
      }
    })
  });
  if (!res.ok) throw new Error(`Tableau auth failed: ${res.status}`);
  const d = await res.json();
  return d.credentials.token;
}

async function query(token, fields, filters = []) {
  const res = await fetch(`${HOST}/api/v1/vizql-data-service/query-datasource`, {
    method: 'POST',
    headers: {
      'X-Tableau-Auth': token,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      datasource: { datasourceLuid: DS_LUID },
      query: { fields, filters }
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`VizQL query failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  return (await res.json()).data ?? [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!PAT || !SECRET) {
    return res.status(503).json({
      error: 'Tableau credentials not configured. Add TABLEAU_PAT_NAME and TABLEAU_PAT_SECRET in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  try {
    const token = await auth();

    const [clubRows, dayRows, heatRows] = await Promise.all([
      query(token, [
        { fieldCaption: 'Club  ',         fieldAlias: 'club' },
        { fieldCaption: 'Head Of Ops',    fieldAlias: 'manager' },
        { fieldCaption: 'TM Joiners-',    fieldAlias: 'joiners' },
        { fieldCaption: 'Target   ',      function: 'SUM', fieldAlias: 'target' },
        { fieldCaption: '+/- Target So far', fieldAlias: 'varTarget' },
        { fieldCaption: '%  ',            fieldAlias: 'pctTarget' },
        { fieldCaption: 'LY Joiners-',   function: 'SUM', fieldAlias: 'lyJoiners' }
      ], [MONTH_FILTER]),

      query(token, [
        { fieldCaption: 'Date ', function: 'DAY', fieldAlias: 'day' },
        { fieldCaption: 'Date ',           fieldAlias: 'date' },
        { fieldCaption: 'TM Joiners-',     fieldAlias: 'joiners' },
        { fieldCaption: 'Target   ', function: 'SUM', fieldAlias: 'target' },
        { fieldCaption: 'LY Joiners-', function: 'SUM', fieldAlias: 'ly' }
      ], [MONTH_FILTER]),

      query(token, [
        { fieldCaption: 'Club  ',      fieldAlias: 'club' },
        { fieldCaption: 'Head Of Ops', fieldAlias: 'manager' },
        { fieldCaption: 'Date ', function: 'DAY', fieldAlias: 'day' },
        { fieldCaption: 'TM Joiners-', fieldAlias: 'joiners' }
      ], [
        MONTH_FILTER,
        {
          field: { fieldCaption: 'TM Joiners-' },
          filterType: 'QUANTITATIVE_NUMERICAL',
          quantitativeFilterType: 'MIN',
          min: 1
        }
      ])
    ]);

    const now = new Date();
    const today     = now.getDate();
    const monthNum  = now.getMonth() + 1;
    const year      = now.getFullYear();
    const dim       = new Date(year, monthNum, 0).getDate();
    const pace      = Math.round((today / dim) * 10000) / 10000;
    const MONTHS    = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = MONTHS[monthNum - 1];
    const refreshedAt = `${String(today).padStart(2,'0')} ${monthName} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const clubs = clubRows.map(c => ({
      name:    c.club,
      mgr:     c.manager?.includes('Kris') ? 'kris' : 'lois',
      joiners: c.joiners   ?? 0,
      target:  Math.round(c.target    ?? 0),
      ly:      Math.round(c.lyJoiners ?? 0),
      varT:    Math.round(c.varTarget  ?? 0),
      pctT:    Math.round((c.pctTarget ?? 0) * 100)
    }));

    const days = dayRows
      .map(d => ({
        day:     d.day,
        joiners: d.joiners ?? 0,
        target:  Math.round(d.target ?? 0),
        ly:      Math.round(d.ly     ?? 0)
      }))
      .sort((a, b) => a.day - b.day);

    const heatMap = {};
    heatRows.forEach(h => {
      if (!heatMap[h.club]) {
        heatMap[h.club] = {
          name: h.club,
          mgr:  h.manager?.includes('Kris') ? 'kris' : 'lois',
          d:    {}
        };
      }
      heatMap[h.club].d[String(h.day)] = h.joiners ?? 0;
    });

    return res.status(200).json({
      today, monthName, monthNum, year,
      daysInMonth: dim, pace,
      refreshedAt,
      clubs,
      days,
      heatData: Object.values(heatMap)
    });

  } catch (err) {
    console.error('Live data error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
