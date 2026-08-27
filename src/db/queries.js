const { query } = require('./client');

let cachedStats = null;
let lastStatsFetch = 0;

async function getStats() {
  const now = Date.now();
  if (cachedStats && (now - lastStatsFetch < 60000)) {
    return cachedStats;
  }

  // Fast estimates and top type sample
  const totalFilesRes = await query(`
    SELECT COALESCE(
      (SELECT reltuples::bigint FROM pg_class WHERE relname = 'files'),
      (SELECT count(*) FROM files)
    ) as total
  `);

  const typeBreakdownRes = await query(`
    SELECT 
      "fileType", 
      count(*) as total, 
      count(CASE WHEN metadata IS NOT NULL THEN 1 END) as with_metadata
    FROM files 
    WHERE "fileType" IS NOT NULL
    GROUP BY "fileType" 
    ORDER BY total DESC 
    LIMIT 15
  `);

  const total = parseInt(totalFilesRes.rows[0].total, 10);
  const fileTypes = typeBreakdownRes.rows.map(r => ({
    fileType: r.fileType,
    total: parseInt(r.total, 10),
    withMetadata: parseInt(r.with_metadata, 10)
  }));

  const totalWithMetadata = fileTypes.reduce((acc, t) => acc + t.withMetadata, 0);

  cachedStats = {
    totalFiles: total,
    totalWithMetadata,
    fileTypes
  };
  lastStatsFetch = now;

  return cachedStats;
}

async function getFilesList({ fileType, search, hasMetadata, limit = 15, offset = 0 }) {
  const conditions = [];
  const params = [];

  if (fileType && fileType !== 'all') {
    params.push(fileType);
    conditions.push(`"fileType" = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(filename ILIKE $${params.length} OR "originalFileName" ILIKE $${params.length})`);
  }

  if (hasMetadata === 'true' || hasMetadata === true) {
    conditions.push(`metadata IS NOT NULL`);
  } else if (hasMetadata === 'exiftool') {
    conditions.push(`(metadata::jsonb ? 'ExifToolVersion' OR metadata::jsonb ? 'ImageSize' OR metadata::jsonb ? 'Duration' OR metadata::jsonb ? 'ImageWidth')`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  const countQuery = `SELECT count(*) as total FROM files ${whereClause}`;
  const countRes = await query(countQuery, params.slice(0, -2));

  const listQuery = `
    SELECT 
      id, 
      filename, 
      "originalFileName", 
      "filePath", 
      "s3BucketName", 
      "fileType", 
      "fileSize",
      "createdAt",
      "updatedAt",
      CASE 
        WHEN metadata IS NOT NULL 
        THEN true 
        ELSE false 
      END as has_metadata,
      CASE 
        WHEN metadata::jsonb ? 'ExifToolVersion' OR metadata::jsonb ? 'ImageSize' OR metadata::jsonb ? 'Duration' OR metadata::jsonb ? 'ImageWidth'
        THEN 'exiftool_cloudconvert'
        WHEN metadata::jsonb ? 'ETag' OR metadata::jsonb ? 'AcceptRanges'
        THEN 's3_head_only'
        ELSE 'custom_or_empty'
      END as metadata_type
    FROM files 
    ${whereClause}
    ORDER BY id DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex}
  `;

  const listRes = await query(listQuery, params);

  return {
    total: parseInt(countRes.rows[0].total, 10),
    limit,
    offset,
    files: listRes.rows
  };
}

async function getFileById(id) {
  const res = await query('SELECT * FROM files WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getSampleFilesForComparison(countPerType = 2) {
  const keyTypes = [
    'image/png',
    'image/jpeg',
    'video/mp4',
    'video/quicktime',
    'application/pdf',
    'image/vnd.adobe.photoshop',
    'application/postscript',
    'image/webp'
  ];

  const results = [];
  for (const type of keyTypes) {
    const res = await query(`
      SELECT id, filename, "originalFileName", "filePath", "s3BucketName", "fileType", "fileSize", metadata
      FROM files
      WHERE "fileType" = $1 
        AND metadata IS NOT NULL 
        AND (metadata::jsonb ? 'ExifToolVersion' OR metadata::jsonb ? 'ImageSize' OR metadata::jsonb ? 'ImageWidth' OR metadata::jsonb ? 'Duration')
      ORDER BY id DESC
      LIMIT $2
    `, [type, countPerType]);

    results.push(...res.rows);
  }
  return results;
}

module.exports = {
  getStats,
  getFilesList,
  getFileById,
  getSampleFilesForComparison
};
