const {
  classifyKey,
  normalizeValue,
  areValuesEquivalent,
  CRITICAL_VAULT_KEYS,
  TRANSIENT_KEYS
} = require('../utils/normalizer');

class ComparatorService {
  /**
   * Compare CloudConvert metadata with ExifTool metadata
   * @param {Record<string, any>} ccMeta - CloudConvert metadata (e.g. from DB)
   * @param {Record<string, any>} etMeta - ExifTool metadata
   * @returns {Object} Comparison report
   */
  compare(ccMeta = {}, etMeta = {}) {
    const allKeys = Array.from(new Set([
      ...Object.keys(ccMeta || {}),
      ...Object.keys(etMeta || {})
    ])).sort();

    const fieldComparisons = [];

    let criticalTotal = 0;
    let criticalMatched = 0;
    let intrinsicTotal = 0;
    let intrinsicMatched = 0;
    let transientCount = 0;

    for (const key of allKeys) {
      const classification = classifyKey(key);
      const ccVal = ccMeta ? ccMeta[key] : undefined;
      const etVal = etMeta ? etMeta[key] : undefined;

      const inCC = ccVal !== undefined;
      const inET = etVal !== undefined;

      let status = 'MISMATCH';

      if (classification === 'TRANSIENT') {
        transientCount++;
        status = 'TRANSIENT_IGNORED';
      } else if (inCC && inET) {
        const isMatch = areValuesEquivalent(ccVal, etVal);
        if (isMatch) {
          status = ccVal === etVal ? 'EXACT_MATCH' : 'EQUIVALENT_MATCH';
          if (classification === 'CRITICAL') {
            criticalTotal++;
            criticalMatched++;
          } else {
            intrinsicTotal++;
            intrinsicMatched++;
          }
        } else {
          status = 'MISMATCH';
          if (classification === 'CRITICAL') criticalTotal++;
          else intrinsicTotal++;
        }
      } else if (inCC && !inET) {
        status = 'MISSING_IN_EXIFTOOL';
        if (classification === 'CRITICAL') criticalTotal++;
        else intrinsicTotal++;
      } else if (!inCC && inET) {
        status = 'EXTRA_IN_EXIFTOOL';
        // Extra tags in ExifTool are advantageous (more metadata preserved)
        if (classification === 'CRITICAL') {
          criticalTotal++;
        } else {
          intrinsicTotal++;
          intrinsicMatched++; // Count as positive discovery
        }
      }

      fieldComparisons.push({
        key,
        classification,
        cloudConvertValue: ccVal !== undefined ? ccVal : null,
        exifToolValue: etVal !== undefined ? etVal : null,
        status,
        isMatch: status === 'EXACT_MATCH' || status === 'EQUIVALENT_MATCH' || status === 'TRANSIENT_IGNORED'
      });
    }

    const criticalMatchRate = criticalTotal > 0 ? (criticalMatched / criticalTotal) * 100 : 100;
    const intrinsicMatchRate = intrinsicTotal > 0 ? (intrinsicMatched / intrinsicTotal) * 100 : 100;
    const totalConsidered = criticalTotal + intrinsicTotal;
    const totalMatched = criticalMatched + intrinsicMatched;
    const overallMatchRate = totalConsidered > 0 ? (totalMatched / totalConsidered) * 100 : 100;

    let verdict = 'PERFECT_MATCH';
    let verdictMessage = 'All metadata and critical fields match between CloudConvert and ExifTool.';

    if (criticalMatchRate < 100) {
      verdict = 'CRITICAL_MISMATCH';
      verdictMessage = 'Some critical fields used by The Vault have differences. Check the critical fields table.';
    } else if (overallMatchRate >= 90) {
      verdict = 'COMPATIBLE_EXIFTOOL_REPLACEMENT';
      verdictMessage = '100% of critical Vault fields match! ExifTool is a direct drop-in replacement for CloudConvert.';
    } else {
      verdict = 'PARTIAL_MATCH';
      verdictMessage = 'Critical fields match, but some non-critical tags have formatting variations.';
    }

    return {
      verdict,
      verdictMessage,
      summary: {
        totalKeys: allKeys.length,
        totalEvaluated: totalConsidered,
        totalMatched,
        overallMatchRate: Number(overallMatchRate.toFixed(2)),
        critical: {
          total: criticalTotal,
          matched: criticalMatched,
          matchRate: Number(criticalMatchRate.toFixed(2))
        },
        intrinsic: {
          total: intrinsicTotal,
          matched: intrinsicMatched,
          matchRate: Number(intrinsicMatchRate.toFixed(2))
        },
        transientCount
      },
      fields: fieldComparisons
    };
  }
}

module.exports = new ComparatorService();
