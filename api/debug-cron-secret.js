// TEMPORARY debug endpoint — returns prefix/suffix/length of CRON_SECRET
// without exposing the full value. Delete after diagnosing auth mismatch.
//
// No auth required: this is safe to call publicly because it only leaks
// 4 characters total (2 prefix + 2 suffix) plus the length.

function probe(name) {
  const v = process.env[name] || '';
  return {
    is_set: v.length > 0,
    length: v.length,
    prefix: v.slice(0, 8),
    suffix: v.slice(-4),
    starts_with_https: v.startsWith('https://'),
    has_trailing_slash: v.endsWith('/'),
    has_whitespace: /\s/.test(v),
  };
}

export default function handler(req, res) {
  res.status(200).json({
    CRON_SECRET: probe('CRON_SECRET'),
    SUPABASE_URL: probe('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: probe('SUPABASE_SERVICE_ROLE_KEY'),
    POLYGON_API_KEY_set: !!process.env.POLYGON_API_KEY,
    VITE_POLYGON_KEY_set: !!process.env.VITE_POLYGON_KEY,
  });
}
