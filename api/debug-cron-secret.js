// TEMPORARY debug endpoint — returns prefix/suffix/length of CRON_SECRET
// without exposing the full value. Delete after diagnosing auth mismatch.
//
// No auth required: this is safe to call publicly because it only leaks
// 4 characters total (2 prefix + 2 suffix) plus the length.

export default function handler(req, res) {
  const v = process.env.CRON_SECRET || '';
  res.status(200).json({
    is_set: v.length > 0,
    length: v.length,
    prefix: v.slice(0, 4),
    suffix: v.slice(-4),
    ends_with_equals: v.endsWith('='),
  });
}
