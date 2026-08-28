# Executive Proposal: Standardizing Media Metadata Extraction via In-House Engine

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

## 2. Ingestion Architecture Workflow

```
1. [User / Frontend] ──(Direct File Upload)──> [Amazon S3]
2. [Frontend] ──(Upload Complete API Call)──> [Backend Service]
3. [Backend Service] ──(Enqueue Task)──> [Amazon SQS Queue Buffer]
4. [Amazon SQS Queue] ──(Asynchronous Trigger)──> [Existing AWS Lambda (In-House Engine: <400ms)]
5. [Existing AWS Lambda] ──(Direct Database Save)──> [PostgreSQL files.metadata]
```

* **Step 1**: The user uploads the media file directly from the browser to Amazon S3.
* **Step 2**: Once the S3 upload finishes, the frontend notifies the backend via an API call.
* **Step 3**: The backend places the extraction task onto an **Amazon SQS message queue buffer** in a non-blocking (fire-and-forget) manner, completing the user request immediately.
* **Step 4**: The existing AWS Lambda reads the message and extracts the technical metadata directly from the S3 stream in **under 400 milliseconds**.
* **Step 5**: The **Lambda writes the normalized metadata directly into the PostgreSQL database** using its database connection.

---

## 3. Forensic Analysis: 6-Year Schema Drift & Database Impact

A forensic database audit of **593,504 files** in the database revealed how CloudConvert's silent upstream tool upgrades generated distinct generations of conflicting metadata structures:

### Historical Metadata Generations in the Database

| Generation | Engine Version Recorded | Asset Count | Date Range | Impact on Database Records |
| :--- | :---: | :---: | :---: | :--- |
| **Generation 1** | **`v12.36`** | **18,029** | Feb 2022 – Feb 2024 | Early CloudConvert worker version (decimal duration formats, early bitrate tags) |
| **Generation 2** | **`v12.56`** | **271,126** | Nov 2021 – Aug 2026 | CloudConvert container upgrade (timecode duration shifts, enhanced vector artboard tags) |
| **Generation 3** | **`NO_EXIFTOOL_TAG`** | **272,602** | Mar 2022 – Aug 2026 | S3 header-only or non-standard extractions |

---

### Real-World Discrepancy Case Studies from Historical Data

#### Case 1: Video Duration Format Shift (Decimal Seconds vs. Timecodes)
* **The Problem**: In earlier uploads, video duration was stored as a decimal string with unit (`"20.00 s"`). Following upstream tool updates, the format shifted to a timecode string (`"0:00:30"`).
* **Engineering Impact**: Standard numerical parsing functions (`parseFloat`) evaluate `"0:00:30"` as `0`, causing downstream rendering engines to miscalculate asset length unless complex string-splitting fallback logic was applied.
* **Database Evidence**:
  * File `#259754` (`SO_Enterprise_C12_Rent_A_Car_ENG_Molde_1.mp4`, uploaded 2024-09-19): `Duration: "20.00 s"`
  * File `#475028` (`Allstate_C1_Generic_ATX_Base_South.mp4`, uploaded 2026-01-27): `Duration: "0:00:30"`

#### Case 2: Bitrate Tag Splitting (`AvgBitrate` vs. `Bitrate` vs. `VideoBitrate`)
* **The Problem**: Older systems looked for a single `Bitrate` field. Newer MP4/MOV extractions exclusively output `AvgBitrate`, while MPEG videos output `VideoBitrate`.
* **Database Evidence**: Across 142,287 MP4 videos, **117,445 files** contain `AvgBitrate`, while only **8 files** contain `Bitrate`. Code querying `metadata.Bitrate` returned empty values for over 99% of video assets.

#### Case 3: Adobe Illustrator Canvas Dimensions (`MaxPageSizeW` vs. `ImageWidth`)
* **The Problem**: Vector artwork files (`.ai` / `.eps`) do not contain a pixel grid. ExifTool returns `ImageWidth: null` and instead stores the true artboard canvas dimensions inside `MaxPageSizeW` and `BoundingBox`.
* **Database Evidence**: Across 2,099 Adobe Illustrator master assets, `ImageWidth` is completely null. Backend services were forced to write dedicated conditional handlers for Illustrator:
  * File `#381646` (`SO_P&G_Gillette_C2_SharedStatic_Base_Artwork_1.ai`): `ImageWidth: null`, `MaxPageSizeW: "242"`, `BoundingBox: "-4 -263 1746 14"`
  * File `#307768` (`SO_UEFA_C6_VAR_Base_144px_(246m)_1.ai`): `ImageWidth: null`, `MaxPageSizeW: "18800"`

#### Case 4: Document Page Count Tag Changes (`PageCount` vs. `Pages`)
* **The Problem**: Early PostScript files recorded document lengths under `Pages`, whereas standard PDF extractions output `PageCount`.
* **Database Evidence**:
  * File `#308888` (`Brax_C15_SUPERBET_ISG_Virtual_Carpets_All_Venues_1.pdf`): `PageCount: "1"`, `Pages: null`
  * 30 legacy PostScript documents contain `Pages: 1`.

#### Case 5: PNG Resolution & DPI Inconsistencies (`XResolution` vs. `PixelsPerUnitX`)
* **The Problem**: Image resolution is recorded either under `XResolution` (in inches) or raw pixel density `PixelsPerUnitX` (in meters) depending on the authoring software and upstream parser state.
* **Database Evidence**:
  * File `#562777` (`1XBET_C11_222_BA2_BGR.png`): contains `XResolution: "144"`, `ResolutionUnit: "inches"`, and `PixelsPerUnitX: "5669"`.
  * File `#546446` (`AFC_Commercial_Team_C4_Ca3_FT_5.png`): `XResolution: null`, and only `PixelsPerUnitX: "2835"`.

#### Case 6: Photoshop Layer Data & Color Spaces (PSD Assets)
* **The Problem**: Master Photoshop PSD files require layer count and color space data for automated rendering. Upstream changes varied between returning raw color space integers vs. descriptive strings.
* **Database Evidence**:
  * File `#393594` (`National_Partners-Shared_Artwork_C9_V2_Miele_Base_144_1.psd`): `LayerCount: "4"`, `ColorSpace: "sRGB"`
  * File `#377806` (`SO_Apple_C7_Stick_Group_2_Base_2.psd`): `LayerCount: "11"`, `ColorSpace: "Uncalibrated"`

---

## 4. Proof of Concept (POC) Validation & Benchmark Results

A Proof of Concept was developed to verify data parity between live CloudConvert API responses and the in-house extraction engine across representative media formats in The Vault catalog:

| Media Format | Asset Type | Extracted Technical Attributes | Verification Status |
| :--- | :--- | :--- | :--- |
| **PNG** | Brand graphics, transparent overlays | Dimensions, Bit Depth, Color Type, DPI, Gamma | 100% Parity |
| **JPEG** | Photography, campaign images | Dimensions, EXIF metadata, Megapixels, Color Space | 100% Parity |
| **MP4** | Video commercials, board renders | Resolution, Duration, Framerate, Bitrate, Codecs | 100% Parity |
| **QuickTime MOV** | High-definition master videos | Resolution, TimeScale, Duration, Codec profile | 100% Parity |
| **PDF** | Print proofs, campaign specifications | Page Count, PDF Version, Creator Software, Linearization | 100% Parity |
| **Adobe Illustrator (AI / EPS)** | Vector artwork, signage dimensions | Artboard Dimensions, Bounding Box, XMP metadata | 100% Parity |
| **Adobe Photoshop (PSD)** | Multi-layer master graphics | Layer Count, Blend Modes, Layer Names, Color Profile | 100% Parity |
| **WebP** | Web banners | Dimensions, Compression mode, Alpha channel | 100% Parity |

---

### Live Real-Time Benchmark Comparison

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

## 5. Architectural Enhancements & Stability

In addition to replacing the external service call inside the Lambda, we recommend adding an **Amazon SQS message queue buffer** between the backend API and the Lambda:

1. **Burst Upload Protection**: During large campaign launches where multiple assets are uploaded simultaneously, the queue cleanly buffers incoming jobs. This ensures the Lambda processes files steadily without spiking concurrent database connections.
2. **Automated Error Handling**: If an invalid or corrupted file is uploaded, the queue safely routes it to a Dead-Letter Queue (DLQ) for alerting, without interrupting the processing of other assets.
3. **Enhanced Security**: Media assets remain entirely inside our private AWS environment and are never transmitted to external third-party infrastructure.

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
