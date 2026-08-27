/**
 * Normalization & Classification Utility for Metadata Comparison
 */

// Keys that are strictly checked by the-vault backend services
const CRITICAL_VAULT_KEYS = new Set([
  'ImageWidth',
  'ImageHeight',
  'ImageSize',
  'Megapixels',
  'Duration',
  'AvgBitrate',
  'BitDepth',
  'ColorType',
  'ColorSpace',
  'FileType',
  'FileTypeExtension',
  'MIMEType',
  'MaxPageSizeW',
  'MaxPageSizeH',
  'ImageDimentions',
  'codec_name',
  'codec_long_name',
  'width',
  'height',
  'bit_rate',
  'sample_aspect_ratio',
  'display_aspect_ratio',
  'pix_fmt',
  'Orientation',
  'Pages',
  'PageCount',
  'PDFVersion',
  'AudioChannels',
  'AudioSampleRate'
]);

// Keys that are environmental/transient artifacts (filesystem permissions, S3 headers, tool version, warnings)
const TRANSIENT_KEYS = new Set([
  'Directory',
  'SourceFile',
  'ExifToolVersion',
  'FileAccessDate',
  'FileInodeChangeDate',
  'FileModifyDate',
  'FilePermissions',
  'warnings',
  'errors',
  'AcceptRanges',
  'LastModified',
  'ContentLength',
  'ETag',
  'VersionId',
  'ContentDisposition',
  'ContentType',
  'ServerSideEncryption',
  'Metadata',
  '$metadata',
  'scanResult'
]);

/**
 * Classify a metadata key
 */
function classifyKey(key) {
  if (CRITICAL_VAULT_KEYS.has(key)) return 'CRITICAL';
  if (TRANSIENT_KEYS.has(key)) return 'TRANSIENT';
  return 'INTRINSIC';
}

/**
 * Normalize a single value for fair semantic comparison
 */
function normalizeValue(val) {
  if (val === null || val === undefined) return null;

  // Handle ExifDateTime objects
  if (typeof val === 'object' && val._ctor === 'ExifDateTime') {
    return val.rawValue || `${val.year}:${String(val.month).padStart(2, '0')}:${String(val.day).padStart(2, '0')}`;
  }

  // Handle strings that are actually JSON
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return normalizeValue(JSON.parse(trimmed));
      } catch (e) {
        // keep as string
      }
    }

    // Numeric strings: "1920" -> 1920
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && !trimmed.startsWith('0x')) {
      const num = Number(trimmed);
      if (!isNaN(num)) return num;
    }

    // Boolean strings
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;

    return trimmed;
  }

  // Handle dates/objects
  if (val instanceof Date) {
    return val.toISOString();
  }

  if (Array.isArray(val)) {
    return val.map(normalizeValue);
  }

  if (typeof val === 'object') {
    const normalizedObj = {};
    for (const [k, v] of Object.entries(val)) {
      normalizedObj[k] = normalizeValue(v);
    }
    return normalizedObj;
  }

  return val;
}

/**
 * Deep equality check with fuzzy numeric/string tolerance
 */
function areValuesEquivalent(val1, val2) {
  const norm1 = normalizeValue(val1);
  const norm2 = normalizeValue(val2);

  if (norm1 === norm2) return true;
  if (norm1 === null || norm2 === null) return norm1 === norm2;

  // Empty arrays vs null/undefined
  if (Array.isArray(norm1) && Array.isArray(norm2)) {
    if (norm1.length === 0 && norm2.length === 0) return true;
  }

  // Numbers comparison with small floating point tolerance
  if (typeof norm1 === 'number' && typeof norm2 === 'number') {
    return Math.abs(norm1 - norm2) < 0.0001;
  }

  // String comparison case-insensitive or trimmed
  if (typeof norm1 === 'string' && typeof norm2 === 'string') {
    if (norm1.trim() === norm2.trim()) return true;
    if (norm1.toLowerCase() === norm2.toLowerCase()) return true;
  }

  // Object / Array deep comparison
  if (typeof norm1 === 'object' && typeof norm2 === 'object') {
    return JSON.stringify(norm1) === JSON.stringify(norm2);
  }

  return false;
}

module.exports = {
  CRITICAL_VAULT_KEYS,
  TRANSIENT_KEYS,
  classifyKey,
  normalizeValue,
  areValuesEquivalent
};
