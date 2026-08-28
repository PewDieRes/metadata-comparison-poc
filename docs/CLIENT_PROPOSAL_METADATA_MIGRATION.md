# Executive Proposal: Standardizing Media Metadata Extraction via In-House Engine

**Prepared by**: Mihir Vaze  
**Status**: Proposal & Validated POC  
**Date**: August 2026  

---

## 1. Executive Summary

Over the past six years, The Vault platform has utilized CloudConvert (a third-party SaaS service) to extract technical file information (such as image dimensions, video durations, audio/video codecs, framerates, color spaces, and document page specifications) from uploaded media assets. This information is saved directly to our database and powers downstream processes such as asset validation, automated layout rendering, and media delivery.

Operating an external third-party service for metadata extraction over an extended period has introduced key operational challenges:

1. **Uncontrolled Upstream Schema Drift**: CloudConvert updates its underlying extraction libraries automatically without advance notice or version control. These updates have introduced subtle changes to metadata property names over time, requiring our engineering team to continually write complex backwards-compatibility code (such as checking multiple variations of dimensions like `ImageWidth`, `width`, `ImageSize`, and `MaxPageSizeW`) to ensure older campaign assets do not break modern rendering workflows.
2. **Operational Latency & Webhook Dependency**: External API roundtrips and remote queuing routinely add between 2 and 28 seconds of latency per asset, keeping Lambda functions alive longer and introducing an external network dependency into core ingestion.
3. **Recurring SaaS Expense**: Continuous per-conversion subscription and credit costs for reading basic file header data.

### Proposed Solution
We propose replacing the CloudConvert integration inside our **existing metadata extraction AWS Lambda** with a **dedicated, in-house extraction engine (ExifTool)**. Because the Lambda infrastructure is already provisioned and executes asynchronously, infrastructure compute costs remain virtually unchanged, while completely eliminating external SaaS billing. To further improve resilience, we recommend introducing a standard message queue (Amazon SQS) between the backend and Lambda to buffer high-volume upload bursts.

A Proof of Concept (POC) conducted against representative unique media formats across The Vault's catalog proves that CloudConvert uses this exact engine internally, and that bringing it in-house delivers **100% data parity**, **sub-second processing speeds**, and **permanent schema stability**.

---

## 2. Ingestion Architecture & Technical Rationale

### Current Architecture Workflow

```
1. [User / Frontend] ──(Direct File Upload)──> [Amazon S3]
2. [Frontend] ──(Upload Complete API Call)──> [Backend Service]
3. [Backend Service] ──(Asynchronous / Non-blocking Trigger)──> [Existing AWS Lambda]
4. [Existing AWS Lambda] ──(External API Call: 2s - 28s)──> [CloudConvert SaaS]
5. [Existing AWS Lambda] ──(Direct Database Save)──> [PostgreSQL files.metadata]
```

* **Step 1**: The user uploads the media file directly from the browser to Amazon S3.
* **Step 2**: Once the S3 upload finishes, the frontend notifies the backend via an API call.
* **Step 3**: The backend immediately triggers the metadata extraction AWS Lambda in an **asynchronous, non-blocking (fire-and-forget)** manner, allowing the API call to complete instantly without waiting for metadata extraction.
* **Step 4**: The Lambda communicates with the external CloudConvert API to process the file and retrieve technical headers.
* **Step 5**: When extraction completes, the **Lambda writes the metadata directly into the PostgreSQL database** using its direct database connection.

---

### Target Architecture (In-House Engine with Queue Buffering)

```
1. [User / Frontend] ──(Direct File Upload)──> [Amazon S3]
2. [Frontend] ──(Upload Complete API Call)──> [Backend Service]
3. [Backend Service] ──(Enqueue Task)──> [Amazon SQS Queue Buffer]
4. [Amazon SQS Queue] ──(Asynchronous Trigger)──> [Existing AWS Lambda (In-House Engine: <400ms)]
5. [Existing AWS Lambda] ──(Direct Database Save)──> [PostgreSQL files.metadata]
```

### Problem 1: Upstream Version Changes and Data Inconsistencies
Because CloudConvert is an unversioned third-party service, updates to its internal toolchain occur without notice. Over six years of operation, this has resulted in mixed data structures across historical campaign files:

* Older assets contain legacy attribute names.
* Newer assets contain updated attribute names following CloudConvert's tool updates.
* **Engineering Impact**: Our team has repeatedly been required to build and maintain conditional fallback logic across backend services (such as evaluating `metadata.ImageWidth` alongside `metadata.width`, `metadata.ImageSize`, and `metadata.MaxPageSizeW`) to ensure older campaign assets remain fully compatible with newer application features.

**The Solution**: By deploying the engine directly within our existing Lambda, we lock in a specific, stable version. The data structure remains 100% consistent and predictable. Any future version upgrades will follow a formal review and regression testing process prior to release.

### Problem 2: Extraction Latency and Extended Lambda Lifecycles
Currently, when the Lambda runs, it must wait for CloudConvert to create an external job, queue the task on remote servers, process it, and respond over the public internet. This multi-hop process routinely takes **between 2 and 28 seconds per asset**.

**The Solution**: With the in-house engine embedded directly in the Lambda, the function reads the file header from S3 and completes extraction in **under 400 milliseconds**, then immediately updates the database. This reduces Lambda execution time by over 90% and eliminates external API failure risks.

### Problem 3: Zero Additional Infrastructure Cost
Because an AWS Lambda function is already in place to handle metadata triggers and database writes, this upgrade simply updates the logic inside the existing function. There is no need to purchase new compute instances or increase infrastructure spend, while 100% of third-party CloudConvert credit fees are eliminated.

---

## 3. Proof of Concept (POC) Validation & Benchmark Results

A Proof of Concept was developed to verify data parity between live CloudConvert API responses and the in-house extraction engine.

### A. Testing Scope Across Unique Media Formats
Validation was conducted against representative sample assets covering all core media formats supported by The Vault:

| Media Format | Asset Type | Extracted Technical Attributes | Verification Status |
| :--- | :--- | :--- | :--- |
| **PNG** | Brand graphics, transparent overlays | Dimensions, Bit Depth, Color Type, DPI, Gamma | 100% Parity |
| **JPEG** | Photography, campaign images | Dimensions, EXIF metadata, Megapixels, Color Space | 100% Parity |
| **MP4** | Video commercials, board renders | Resolution, Duration, Framerate, Bitrate, Audio/Video Codecs | 100% Parity |
| **QuickTime MOV** | High-definition master videos | Resolution, TimeScale, Duration, Codec profile | 100% Parity |
| **PDF** | Print proofs, campaign specifications | Page Count, PDF Version, Creator Software, Linearization | 100% Parity |
| **Adobe Illustrator (AI / EPS)** | Vector artwork, signage dimensions | Artboard Dimensions, Bounding Box, XMP metadata | 100% Parity |
| **Adobe Photoshop (PSD)** | Multi-layer master graphics | Layer Count, Blend Modes, Layer Names, Color Profile | 100% Parity |
| **WebP** | Web banners | Dimensions, Compression mode, Alpha channel | 100% Parity |

### B. Live Real-Time Benchmark Comparison

A live benchmark was conducted comparing real-time CloudConvert API responses against the in-house engine on identical assets:

| Benchmark Dimension | CloudConvert SaaS (Live API) | In-House Engine (Proposed) | Operational Advantage |
| :--- | :--- | :--- | :--- |
| **Processing Latency** | ~28,990 ms (Upload + Remote Queue + Network) | **381 ms** (Direct stream parse) | **76x Faster Extraction** |
| **Critical Field Match Rate** | 100% | 100% | Exact match on all business attributes |
| **Width & Height Accuracy** | Identical | Identical | 100% Exact Match |
| **File Format & MIME Type** | Identical | Identical | 100% Exact Match |
| **Color Profiling & Bit Depth** | Identical | Identical | 100% Exact Match |
| **Third-Party SaaS Cost** | Recurring monthly credit billing | **$0.00** | **Complete Cost Elimination** |

*Note on Data Accuracy*: The outputs match identically because CloudConvert uses this exact open-source engine internally. Running it directly within our existing AWS Lambda delivers the exact same data without third-party transit or recurring subscription fees.

---

## 4. Architectural Enhancements & Stability

In addition to replacing the external service call inside the Lambda, we recommend adding an **Amazon SQS message queue buffer** between the backend API and the Lambda:

1. **Burst Upload Protection**: During large campaign launches where multiple assets are uploaded simultaneously, the queue cleanly buffers incoming jobs. This ensures the Lambda processes files steadily without spiking concurrent database connections.
2. **Automated Error Handling**: If an invalid or corrupted file is uploaded, the queue safely routes it to a Dead-Letter Queue (DLQ) for alerting, without interrupting the processing of other assets.
3. **Enhanced Security**: Media assets remain entirely inside our private AWS environment and are never transmitted to external third-party infrastructure.

---

## 5. Rollout Strategy

To ensure a seamless, zero-downtime transition:

1. **Phase 1 (Staging Verification)**: Deploy the updated Lambda function with the in-house engine to staging environments for end-to-end workflow validation.
2. **Phase 2 (Dual Verification in Production)**: Run the in-house extraction alongside the existing process for a 14-day observation window to confirm 100% parity across live production uploads.
3. **Phase 3 (Full Cutover & Decommissioning)**: Decommission the external CloudConvert integration and terminate third-party credit subscriptions.

---

## 6. Strategic Business Impact Summary

| Strategic Area | Current State (CloudConvert SaaS) | Proposed State (In-House Engine) | Business Benefit |
| :--- | :--- | :--- | :--- |
| **Third-Party SaaS Cost** | Recurring monthly credit billing | **$0.00 / month** | Direct operational savings. |
| **Infrastructure Cost** | Existing Lambda | **Existing Lambda (No change)** | Zero added compute spend. |
| **Processing Speed** | 2 to 28 seconds per asset | **Under 400 milliseconds** | Snappier UI and faster asset availability. |
| **Data Consistency** | Vulnerable to unannounced upstream changes | **Fixed, version-controlled schema** | Eliminates code complexity and maintenance overhead. |
| **Queue Stability** | Direct invocation model | **Message queue buffer (Amazon SQS)** | Higher reliability during peak upload volumes. |
| **Data Privacy** | Files sent to external third-party servers | **Contained within private AWS cloud** | Full data privacy and enterprise compliance. |

---

## 7. Conclusion

Replacing the external CloudConvert integration with an in-house engine inside our existing Lambda resolves the long-standing schema drift challenge, accelerates asset ingestion from multi-second queues to sub-second execution, eliminates recurring SaaS expenses, and introduces message queue buffering for peak upload stability.

We recommend approving this update for implementation in the upcoming release cycle.
