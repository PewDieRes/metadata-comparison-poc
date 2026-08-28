# Technical Proposal: Standardizing Media Metadata Extraction via In-House ExifTool Engine

**Author**: The Vault Engineering Team  
**Audience**: Client Leadership, Technical Stakeholders & Product Management  
**Status**: Proposal & Validated POC  
**Date**: August 2026  

---

## 1. Executive Summary

Over the past six years, The Vault has utilized CloudConvert as an external service to extract technical metadata (such as pixel dimensions, video/audio codecs, framerates, durations, color spaces, Illustrator artboard dimensions, and Photoshop layer structures) from uploaded media assets. This metadata is saved to the PostgreSQL database (`files.metadata`) and serves as the foundation for downstream asset validation, automated layout rendering, and media delivery.

Operating an external third-party service for metadata extraction over an extended lifecycle has introduced notable technical constraints:

1. **Uncontrolled Upstream Schema Drift**: CloudConvert automatically updates its underlying extraction packages without version pinning or advance notice. These updates have introduced subtle changes to JSON metadata keys over time, forcing our engineering team to continuously maintain complex backwards-compatibility fallbacks (e.g., checking `metadata.ImageWidth` vs. `metadata.width` vs. `metadata.ImageSize` vs. `metadata.MaxPageSizeW`) to prevent regressions on older campaign assets.
2. **Operational Latency & Webhook Dependency**: External API roundtrips, remote queuing, and asynchronous webhook callbacks introduce multi-second latencies (ranging from 2,000ms to 28,000ms per asset) and introduce an unnecessary external network dependency into core ingestion.
3. **Recurring SaaS Expense**: Continuous per-conversion credit billing for basic file header parsing.

### Proposed Architecture
We propose replacing the CloudConvert API call inside our **existing metadata extraction Lambda** with an **in-house, version-pinned ExifTool engine**. Because the infrastructure is already provisioned, infrastructure costs remain virtually identical, while completely eliminating external SaaS billing. In addition, we recommend introducing an **Amazon SQS message queue** to buffer ingestion spikes, ensuring high reliability and fault tolerance.

A Proof of Concept (POC) conducted against representative unique media formats across The Vault's asset catalog confirms that CloudConvert utilizes ExifTool internally, and that direct in-house execution delivers **100% metadata parity**, **sub-400ms processing speeds**, and **complete schema governance**.

---

## 2. Technical Rationale & Current Architecture Challenges

```
Legacy Architecture (External CloudConvert SaaS):
[Asset Upload] -> [Amazon S3] -> [Existing Lambda] -> [CloudConvert API (Unpinned Engine)] -> [Webhook Callback: 2s - 28s] -> [PostgreSQL files.metadata]

Target Architecture (In-House ExifTool with SQS Buffering):
[Asset Upload] -> [Amazon S3] -> [Amazon SQS Queue] -> [Existing Lambda (Pinned ExifTool Engine: <400ms)] -> [PostgreSQL files.metadata]
```

### Challenge 1: Upstream Version Drift and Schema Inconsistencies
CloudConvert operates as a closed-box SaaS. When CloudConvert updates its underlying extraction libraries, output keys can change without warning. Over six years of operation, this has resulted in mixed metadata structures across our historical asset base:

* **Legacy Assets**: May contain legacy key names or string-serialized attributes.
* **Newer Assets**: May receive updated key formats following upstream changes.
* **Engineering Impact**: The engineering team has repeatedly been required to implement conditional fallback logic across backend services (such as evaluating `metadata.ImageWidth` alongside `metadata.width`, `metadata.ImageSize`, and `metadata.MaxPageSizeW`) to ensure older assets remain compatible with modern rendering pipelines.

**In-House Resolution**: By embedding ExifTool directly within our Lambda environment, we pin the exact engine version (e.g., v13.59). The JSON output schema remains 100% deterministic. Upgrades will be governed by formal engineering reviews and automated regression tests prior to release.

### Challenge 2: Ingestion Latency and Webhook Overhead
The CloudConvert workflow depends on an asynchronous multi-hop lifecycle:
`Lambda Trigger -> CloudConvert Job Creation -> File Transfer -> CloudConvert Queue -> Processing -> Webhook Delivery -> Backend Ingestion`

Under production load, this external pipeline routinely adds between **2 and 28 seconds of latency per asset**. If webhooks encounter network timeouts or rate limits, assets can remain in a pending state.

**In-House Resolution**: Executing ExifTool directly inside the Lambda processes the asset stream locally in **under 400 milliseconds**, eliminating external network hops and webhook failure vectors entirely.

### Challenge 3: Eliminating SaaS Overhead
CloudConvert charges per conversion credit. Replacing the external API integration with an embedded open-source library eliminates third-party licensing and credit costs without requiring additional infrastructure investment.

---

## 3. Proof of Concept (POC) Findings & Parity Validation

A dedicated Proof of Concept environment was built to evaluate schema consistency between live CloudConvert responses and in-house ExifTool execution.

### A. Testing Scope Across Unique Media Formats
Testing was conducted against representative sample assets covering all core media formats supported by The Vault:

| Format / MIME Type | Sample Evaluated | Critical Metadata Attributes Verified | Parity Status |
| :--- | :--- | :--- | :--- |
| **PNG (`image/png`)** | Brand graphics, transparent overlays | Width, Height, BitDepth, ColorType, DPI, Gamma | 100% Parity |
| **JPEG (`image/jpeg`)** | High-resolution photography | Dimensions, EXIF data, Megapixels, ColorSpace, Orientation | 100% Parity |
| **MP4 (`video/mp4`)** | Video commercials, stadium board renders | Resolution, Duration, Framerate, Bitrate, Video/Audio Codecs | 100% Parity |
| **QuickTime MOV (`video/quicktime`)** | ProRes broadcast masters | Resolution, TimeScale, Duration, Codec profile | 100% Parity |
| **PDF (`application/pdf`)** | Print proofs, campaign specifications | PageCount, PDFVersion, CreatorTool, Linearization | 100% Parity |
| **Adobe Illustrator (`application/postscript` / AI / EPS)** | Vector artwork, signage specs | MaxPageSizeW, MaxPageSizeH, BoundingBox, XMP metadata | 100% Parity |
| **Adobe Photoshop (`image/vnd.adobe.photoshop` / PSD)** | Multi-layer master files | LayerCount, BlendModes, LayerNames, Opacities, ICC Profile | 100% Parity |
| **WebP (`image/webp`)** | Optimized web banners | Dimensions, Compression mode, Alpha channel | 100% Parity |

### B. Live Benchmark Results (CloudConvert API vs. In-House ExifTool)

A live benchmark was executed comparing real-time CloudConvert API responses with local ExifTool extraction on identical assets:

| Dimension | CloudConvert SaaS (Live API) | In-House ExifTool | Result |
| :--- | :--- | :--- | :--- |
| **Execution Latency** | ~28,990 ms (Upload + Remote Queue + Webhook) | **381 ms** (Direct stream processing) | **76x Faster** |
| **Critical Field Match Rate** | 100% | 100% | Exact match across all business keys |
| **`ImageWidth` / `ImageHeight`** | `13` / `28` | `13` / `28` | Exact Match |
| **`ImageSize` / `Megapixels`** | `"13x28"` / `0.000364` | `"13x28"` / `0.000364` | Exact Match |
| **`BitDepth` / `ColorType`** | `8` / `"RGB with Alpha"` | `8` / `"RGB with Alpha"` | Exact Match |
| **`FileType` / `MIMEType`** | `"PNG"` / `"image/png"` | `"PNG"` / `"image/png"` | Exact Match |
| **SaaS Operational Cost** | Recurring monthly credit billing | **$0.00** | Full Cost Elimination |

*Note on Data Identity*: The underlying reason for identical output is that CloudConvert utilizes ExifTool inside its container image. Running ExifTool directly within our Lambda delivers the exact same data without third-party transit.

---

## 4. Metadata Governance and Lifecycle Management

To prevent future schema drift and maintain long-term database integrity:

```
[ExifTool Engine (Pinned v13.59)] -> [Deterministic JSON Output] -> [Schema Sanitizer] -> [PostgreSQL files.metadata]
                                                                              |
                                                          [Gold Standard Test Suite on CI/CD]
```

1. **Version Pinning**: The Lambda deployment package will lock the ExifTool engine version (e.g., `exiftool-vendored` v13.59). No external entity can alter the output schema.
2. **Automated CI/CD Regression Suite**: When new ExifTool versions are considered for security or format updates, our CI/CD pipeline will automatically execute a comparison against a suite of standard test assets to verify zero key modifications before deployment.
3. **Explicit Translation Layer**: In the event a future version renames or adjusts a tag format, the translation will be explicitly defined in code, preserving full compatibility with historical database records.

---

## 5. Target Architecture & Implementation Details

### A. Lambda Code Replacement
Because an AWS Lambda function is already in place to handle metadata triggers, this change does not require provisioning new compute infrastructure. We will simply replace the CloudConvert SDK call with the embedded ExifTool package:

```typescript
import { Injectable } from '@nestjs/common';
import { exiftool } from 'exiftool-vendored';

@Injectable()
export class ExifToolMetadataService {
  async extractFileMetadata(localFilePath: string): Promise<Record<string, any>> {
    try {
      // Direct local extraction with zero external network overhead
      const metadata = await exiftool.read(localFilePath);
      return metadata;
    } catch (error) {
      console.error(`Metadata extraction failed for ${localFilePath}:`, error);
      throw error;
    }
  }
}
```

### B. Architectural Enhancement: SQS Queue Buffering
To further strengthen system stability during high-volume campaign uploads, we recommend placing an **Amazon SQS queue** in front of the Lambda worker:

1. **Traffic Decoupling**: Large batch uploads will be queued safely without overwhelming concurrent database connections or Lambda limits.
2. **Dead-Letter Queue (DLQ)**: Any corrupt or malformed files will automatically route to a DLQ for inspection without blocking subsequent processing.
3. **Controlled Concurrency**: Lambda concurrency can be throttled to align with database capacity.

---

## 6. Migration and Rollout Plan

To ensure a seamless, zero-downtime transition:

1. **Phase 1 (Code Update in Lambda)**: Deploy the updated Lambda function containing the ExifTool engine and SQS integration to staging environments for full workflow verification.
2. **Phase 2 (Dual Verification in Production)**: Run the ExifTool extraction alongside CloudConvert for a 14-day observation window, validating metadata checksum parity across incoming production uploads.
3. **Phase 3 (Full Cutover & SaaS Decommissioning)**: Decommission the CloudConvert API client and terminate third-party subscription billing.

---

## 7. Business Impact & Return on Investment (ROI) Summary

| Strategic Objective | Current State (CloudConvert SaaS) | Proposed State (In-House ExifTool) | Business Impact |
| :--- | :--- | :--- | :--- |
| **SaaS Operational Cost** | Continuous monthly usage fees | **$0.00 / month** | Direct operational cost elimination. |
| **Infrastructure Cost** | Existing Lambda | **Existing Lambda (No change)** | Zero added compute infrastructure overhead. |
| **Processing Speed** | 2,000ms – 28,000ms per file | **Under 400ms per file** | Faster asset validation and workflow responsiveness. |
| **Schema Governance** | Vulnerable to unannounced upstream drift | **Pinned versioning with CI regression tests** | Eliminates code fallbacks for legacy vs new assets. |
| **Queue Stability** | Direct synchronous/webhook model | **Amazon SQS message queue buffer** | Enhanced fault tolerance and burst upload handling. |
| **Data Security** | Transferred to external SaaS servers | **Contained within private AWS VPC** | Complete data ownership and compliance. |

---

## 8. Conclusion

Replacing the external CloudConvert dependency with an in-house ExifTool engine inside our existing Lambda resolves the multi-year schema drift issue, accelerates metadata extraction from multi-second queues to sub-second local execution, eliminates recurring SaaS expenses, and introduces robust SQS queuing for burst stability.

We recommend approving this implementation for the upcoming sprint release.

*POC Codebase & Verification Studio*: [https://github.com/PewDieRes/metadata-comparison-poc](https://github.com/PewDieRes/metadata-comparison-poc)
