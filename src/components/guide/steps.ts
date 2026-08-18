// Guide panel content (plan Phase 5). Plain data, no React — vitest-testable.
//
// Each step mirrors one sidebar section (section = the SECTION_TESTIDS slug in
// Sidebar.tsx, or null for the intro/wrap-up bookends). Content is drawn from
// docs/design.md: the Talk Workflow, logical types / type assignment, codec
// applicability, metadata serialization, write placement (D1/D2/D3), and the
// read failure taxonomy. Every factual claim here should stay in sync with
// that doc — this file is teaching text, not decoration.

export interface GuideStepOption {
  label: string;
  pros: string;
  cons: string;
}

export interface GuideLink {
  label: string;
  url: string;
}

export interface GuideStep {
  id: string;
  title: string;
  /** Sidebar section slug to highlight, or null (intro/wrap-up). */
  section: string | null;
  /** What the decision at this step actually is (1–2 sentences). */
  decision: string;
  /** The real options, with genuine trade-offs. Empty for null-section steps. */
  options: GuideStepOption[];
  /** Why this decision exists in real formats. */
  body: string;
  /** A concrete action using real UI controls. */
  tryIt: string;
  /** Further-reading blog post links, drawn from BLOG_POSTS. Omitted where irrelevant. */
  links?: GuideLink[];
}

// Element 84 blog posts backing this guide's content. Titles verified against
// each page's <title>/<h1> at authoring time.
export const BLOG_POSTS: GuideLink[] = [
  {
    label: 'Chunks and Chunkability: An Origin Story',
    url: 'https://element84.com/software-engineering/chunks-and-chunkability-an-origin-story/',
  },
  {
    label: 'Chunks and Chunkability: Tyranny of the Chunk',
    url: 'https://element84.com/software-engineering/chunks-and-chunkability-tyranny-of-the-chunk/',
  },
  {
    label: 'Beyond the default: a modern guide to raster compression',
    url: 'https://element84.com/software-engineering/beyond-the-default-a-modern-guide-to-raster-compression/',
  },
  {
    label: 'Metadata makes the data format: metadata storage and representation across array formats',
    url: 'https://element84.com/software-engineering/metadata-makes-the-data-format-metadata-storage-and-representation-across-array-formats/',
  },
  {
    label: 'Is Zarr the new COG?',
    url: 'https://element84.com/software-engineering/is-zarr-the-new-cog/',
  },
];

export const STEPS: GuideStep[] = [
  {
    id: 'intro',
    title: 'Welcome: values become bytes',
    section: null,
    decision:
      'This guide walks the sidebar top to bottom, the same order a file format makes its ' +
      'decisions: what the data is, how it is arranged, how it is encoded, and how it is ' +
      'written — then reads the result back to see what survived.',
    options: [],
    body:
      'Everything here is one live pipeline: Values → Typed → Linearized → Encoded → ' +
      'Metadata → Write → Read. The two panes show any stage side by side, and every byte ' +
      'carries provenance back to the value it came from — until an entropy codec destroys ' +
      'that mapping, which is itself one of the lessons. Nothing you configure is blocked, ' +
      'even when it is a bad idea; the garbled output is the point.',
    tryIt:
      'Hover a value in the left pane (Values, Table view) and watch its bytes light up in ' +
      'the right pane (Write, Hex view). The hover bar above the panes names the value, its ' +
      'coordinates, and its dtype at that stage.',
    links: BLOG_POSTS,
  },
  {
    id: 'schema',
    title: 'Schema: what the data is',
    section: 'schema',
    decision:
      'Define the dataset: its shape, its variables, and what each variable’s values look ' +
      'like — a logical type (integer, decimal, or continuous with a range, or text drawn ' +
      'from a word set) plus a generation mode that controls the data’s structure.',
    options: [
      {
        label: 'random',
        pros: 'Worst-case input — the honest baseline for judging every codec you add later.',
        cons: 'Near-maximum entropy: no runs, no trends, nothing for RLE, LZ, or Delta to exploit.',
      },
      {
        label: 'smooth (random walk)',
        pros: 'Neighboring values are close, so Delta produces small differences — like real sensor data.',
        cons: 'Values still vary continuously; runs are rare, so RLE alone gains little.',
      },
      {
        label: 'sorted',
        pros: 'Monotonic — deltas are small and non-negative, like an indexed or timestamp column.',
        cons: 'Real data is rarely fully sorted; this models a column a database chose to order.',
      },
      {
        label: 'stepped',
        pros: 'Long constant runs — RLE’s ideal input, like category codes or classification bands.',
        cons: 'The step boundaries are the only information; almost any codec looks great on it.',
      },
    ],
    body:
      'The tool has one data model, not two: a table is just a 1-d dataset whose variables ' +
      '(columns) may differ in type, and a raster is the same thing in 2-d. Real formats make ' +
      'the same move — Parquet columns, GeoTIFF bands, and Zarr arrays all answer "what ' +
      'variables, what shape, what values". Generation mode matters because everything ' +
      'downstream is a bet on the data’s structure: the defaults (smooth temperature, sorted ' +
      'pressure, stepped humidity) exist so each later stage has something honest to show. ' +
      'Variables need not be numeric: the text type draws words from a bundled set — names, ' +
      'cities, countries, or prefix-heavy station IDs like WX-0042-A — and because the sets ' +
      'are stored sorted, the same four modes shape categorical data too: stepped becomes ' +
      'runs of one repeated word, sorted becomes alphabetical order. Each variable also has ' +
      'its own Source dropdown, which loads a real public-domain dataset (terrain, ' +
      'sea-surface temperature, weather stations) in place of the generator for that one ' +
      'variable — the four format presets in the header ship with sources pre-wired, so the ' +
      'pipeline is real but the choice of pipeline and the choice of data are independent.',
    tryIt:
      'In Schema, change temperature’s generation from smooth to random and watch the Values ' +
      'pane. Then check the Encoded stage’s entropy stat in the pipeline strip — random data ' +
      'starts near the ceiling before you have applied a single codec.',
  },
  {
    id: 'typing',
    title: 'Type assignment: precision for bytes',
    section: 'typing',
    decision:
      'Choose each variable’s storage dtype: how many bytes to spend per value, and what ' +
      'precision to give up. This is where lossiness enters the pipeline — before any codec runs.',
    options: [
      {
        label: 'float64 (8 bytes)',
        pros: 'Stores every generated value exactly. Nothing to explain in the diff view.',
        cons: 'Eight bytes per value, most of them noise-like mantissa bits that compress poorly.',
      },
      {
        label: 'float32 (4 bytes)',
        pros: 'Half the size; plenty of precision for values like "23.4".',
        cons: 'Values with more precision than ~7 significant digits get rounded — genuinely lossy.',
      },
      {
        label: 'int16 + scale/offset (2 bytes)',
        pros: 'A quarter of float64’s size. (value − offset) × scale quantizes decimals onto an integer grid — scale 10 keeps one decimal place exactly.',
        cons: 'Values outside the representable range clamp, and anything finer than the scale step rounds away. You must pick scale/offset to fit min/max.',
      },
      {
        label: 'char[N] fixed-width text (4/8/16 bytes)',
        pros: 'Every value occupies exactly N bytes, so chunking, seeking, and tracing stay trivial — the same bet DBF and NetCDF-classic made — and the hex view’s ASCII column shows the words directly.',
        cons: 'Too narrow truncates — "Wellington" in char8 stores "Wellingt", counted in the truncated stat and flagged lossy at Read. Too wide pads — char16 cities are mostly trailing spaces.',
      },
      {
        label: 'keepBits (float bit-rounding)',
        pros: 'Zeroing mantissa bits you don’t need creates trailing zero bytes that shuffle + compress beautifully, while keeping float semantics.',
        cons: 'Irrecoverably truncates precision — the diff view will show it. Choosing keepBits requires knowing your data’s real precision.',
      },
    ],
    body:
      'Every real format’s schema answers this same question: Parquet separates logical from ' +
      'physical types, GeoTIFF has a sample format tag, Zarr has dtype plus filters. The tool ' +
      'deliberately makes it a pipeline stage (Typed) rather than a codec: "what does this ' +
      'value mean" and "how many bytes do I spend representing it" are different decisions. ' +
      'The stats beside each variable (clipped, rounded, lossy) come from this stage and feed ' +
      'the Read stage’s diff view later. Text faces the same size-versus-fidelity trade as ' +
      'numbers, just with truncation and padding instead of rounding; real formats eventually ' +
      'reach for offset arrays or dictionaries to store variable-length strings — complexity ' +
      'this tool leaves out on purpose.',
    tryIt:
      'Set temperature’s storage dtype to int16 with scale 1: the Typed stage halves, the ' +
      'stats show rounded values, and the Read diff view shows errors up to half a degree. ' +
      'Now set scale to 10 — one decimal place fits the integer grid exactly and the error ' +
      'vanishes. Same dtype, same size; the scale factor did the work.',
  },
  {
    id: 'chunk',
    title: 'Chunking: few big or many small',
    section: 'chunk',
    decision:
      'Split the dataset into chunks — the unit of storage and retrieval. The chunk shape ' +
      'decides whether a reader can grab a small piece of the data without touching the rest.',
    options: [
      {
        label: 'One big chunk (chunk shape = full shape)',
        pros: 'Simplest layout, no per-chunk overhead, and codecs see the whole dataset as one stream — the most context to compress with.',
        cons: 'All-or-nothing access: reading any single value means decoding everything. No parallel reads or writes.',
      },
      {
        label: 'Many small chunks',
        pros: 'Random access to a small region touches only the chunks that cover it; chunks can be read, written, or decoded in parallel.',
        cons: 'Each chunk needs a chunk-index entry, and codecs compress each chunk in isolation — less context, worse ratios. Thousands of tiny chunks is mostly overhead.',
      },
    ],
    body:
      'This is why GeoTIFF has tiles, Zarr has chunks, and Parquet has row groups: nobody ' +
      'wants to decompress a 10 GB file to look at one corner of it. Chunking trades ' +
      'compression context and index overhead for addressability. It is purely structural — ' +
      'the byte content of the data does not change, only its topology — but it constrains ' +
      'everything downstream, because codecs and the chunk index both operate per chunk. ' +
      'On a 2-D+ array, chunking answers "what goes together" but not "in what order those ' +
      'bytes are written": the Order control (C, Fortran, or Morton/Z-order) walks each ' +
      'chunk’s multi-dimensional grid into a single byte stream. C order varies the last ' +
      'dimension fastest (row-major — C, NumPy, and Zarr’s default); Fortran order varies the ' +
      'first dimension fastest (column-major — MATLAB, and classic Fortran arrays); Morton ' +
      'interleaves the bits of each coordinate, so bytes that are close in space stay close in ' +
      'the file even along the "wrong" axis — the trick behind spatial databases and quadtree ' +
      'tiling. It is purely a byte-ordering choice within a chunk, same as row/column ' +
      'interleaving is a byte-ordering choice across variables — nothing about the values ' +
      'changes, only where their bytes land.',
    tryIt:
      'Set the chunk shape from 32 down to 8. The Linearized stage’s hex view now shows four ' +
      'chunk regions instead of one, and the Metadata section’s chunk_index entry grows to ' +
      'four offset entries. Try 1 and watch ChunkConfig call out the chunk count. On an N-d ' +
      'array, switch Order from C to Morton and watch the Linearized stage’s hex view reorder ' +
      'within each chunk — same byte count, different first row — while Read still round-trips.',
    links: BLOG_POSTS.filter((p) => p.url.includes('chunks-and-chunkability')),
  },
  {
    id: 'interleave',
    title: 'Interleaving: row or column',
    section: 'interleave',
    decision:
      'Within each chunk, arrange the variables: row-oriented interleaves one element of each ' +
      'variable in turn (record by record), column-oriented stores each variable’s bytes ' +
      'contiguously (band-sequential).',
    options: [
      {
        label: 'Row-oriented (interleaved)',
        pros: 'A whole record is one contiguous read — one seek gets you every field of element N. Natural for transactional, row-at-a-time access.',
        cons: 'Codecs see a mixed byte stream of alternating dtypes, so one shared pipeline must serve all variables — Delta and Byte Shuffle produce garbage on heterogeneous elements.',
      },
      {
        label: 'Column-oriented (contiguous)',
        pros: 'Each variable gets its own codec pipeline tuned to its own dtype and structure, and similar bytes cluster together — the layout compression wants.',
        cons: 'Reading one whole record now touches every variable’s region — scattered reads instead of one. Row-at-a-time workloads pay for the analytics-friendly layout.',
      },
    ],
    body:
      'This is the Parquet-versus-CSV lesson in one toggle. A CSV (or any row store) is ' +
      'optimized for "give me record 17"; Parquet is optimized for "give me the temperature ' +
      'column, compressed well". The imaging world made the same split decades earlier as BIP ' +
      'versus BSQ. Note what the tool does when you switch: per-variable pipelines become ' +
      'inactive in row mode but are preserved, and the Codecs section swaps to a single ' +
      'per-chunk pipeline with a warning about mixed dtypes.',
    tryIt:
      'Switch Interleave to row-oriented and look at the Linearized hex view: the variable ' +
      'colors now alternate per element instead of forming solid bands. The Codecs section ' +
      'collapses to one pipeline and explains why. Switch back — your per-variable pipelines ' +
      'come back untouched.',
  },
  {
    id: 'codecs',
    title: 'Codecs: prepare, then compress',
    section: 'codecs',
    decision:
      'Build an ordered codec pipeline per variable (column mode) or per chunk (row mode), ' +
      'picked from one flat list: Delta, Zigzag, Byte Shuffle, Bit Shuffle, Dictionary, RLE, ' +
      'Deflate, GZip, Zstd. Reordering codecs rearrange bytes to expose redundancy; entropy ' +
      'codecs actually shrink it. Order matters: prepare first, compress last.',
    options: [
      {
        label: 'Delta + Zigzag (reordering)',
        pros: 'Delta stores value-to-value differences — smooth or sorted data collapses to small numbers. Zigzag then maps those signed diffs to unsigned so small magnitudes stay small byte values (Parquet’s move ahead of RLE/bit-packing).',
        cons: 'Delta is plain integer arithmetic over an element size you set, so it is only meaningful when that size matches what the bytes actually are — on float dtypes it differences raw IEEE bit patterns rather than numbers, reversibly but uselessly; Zigzag only applies to signed integer dtypes and is a no-op without a preceding signed-producing step.',
      },
      {
        label: 'Byte Shuffle / Bit Shuffle (reordering)',
        pros: 'Byte Shuffle transposes bytes by position within each element, clustering near-constant high bytes together; Bit Shuffle does the same one level finer, transposing individual bits into planes. Both feed the entropy codecs that follow.',
        cons: 'Byte Shuffle’s elementSize must match the actual dtype size or bytes get grouped across value boundaries — garbled output the tool warns about but allows. Neither helps single-byte dtypes (nothing to transpose within one byte).',
      },
      {
        label: 'Dictionary (entropy)',
        pros: 'Parquet’s workhorse: distinct values go into a dictionary, the stream becomes indices into it — dramatic wins on low-cardinality data (categories, repeated station IDs).',
        cons: 'High-cardinality data (near-random values) makes the dictionary as large as the data itself, plus index overhead — a net loss.',
      },
      {
        label: 'RLE (entropy)',
        pros: 'Runs become (count, value) pairs — devastating on stepped data or shuffled high bytes.',
        cons: 'On data without runs it doubles the size (every byte becomes a pair). Output is opaque uint8 — per-byte tracing ends here.',
      },
      {
        label: 'Deflate / GZip / Zstd (real, general-purpose)',
        pros: 'Actual numcodecs implementations (via Pyodide) — the same algorithms behind .gz files and modern Zarr. Find repeated byte sequences within a window, not just adjacent runs, so they generalize past RLE.',
        cons: 'Literal overhead makes incompressible input grow; like RLE they collapse the dtype to uint8 and degrade tracing to chunk level. Real compression, so the first use in a session pays a one-time Pyodide load.',
      },
    ],
    body:
      'This two-phase shape — transforms that create redundancy, then a general-purpose ' +
      'compressor — is exactly how Zarr filters + Blosc, Parquet encodings + Snappy, and HDF5 ' +
      'shuffle + gzip work. Watch two things as you experiment: the dtype annotation flowing ' +
      'through the pipeline (entropy codecs collapse it to uint8), and the hover tracing — ' +
      'after RLE, Dictionary, Deflate, GZip, or Zstd, hovering an encoded byte highlights the ' +
      'whole source chunk, because individual bytes no longer map to individual values. That ' +
      'opacity is why metadata must record the pipeline: nothing about the bytes themselves ' +
      'says how to reverse them. Text has its own version of the pairing: RLE devours the ' +
      'trailing-space padding of short words in char16, Dictionary devours outright repeats, ' +
      'and it is the general-purpose compressors that shrink the words themselves — shared ' +
      'station-ID prefixes are byte sequences, not same-byte runs or exact repeats. Delta on ' +
      'text falls back to meaningless byte-wise differences; the tool warns but stays lossless.',
    tryIt:
      'Add Delta then RLE to humidity (stepped — long runs) and watch its Encoded bytes ' +
      'shrink. Add the same two codecs to temperature after setting its generation to random: ' +
      'the byte count grows and turns the warning color. Same pipeline, opposite result — the ' +
      'codec was never the point; the data’s structure was. Then swap RLE for Zstd and compare.',
    links: BLOG_POSTS.filter((p) => p.url.includes('beyond-the-default-a-modern-guide-to-raster-compression')),
  },
  {
    id: 'metadata',
    title: 'Metadata: the file describes itself',
    section: 'metadata',
    decision:
      'Choose how the file’s self-description — schema, shape, chunk layout, codec pipelines, ' +
      'chunk index, plus your own key-value entries — is serialized into bytes.',
    options: [
      {
        label: 'JSON serialization',
        pros: 'Human-readable in the hex view’s ASCII column; debuggable with your eyes. What Zarr and STAC chose.',
        cons: 'Verbose — the text of the metadata can rival small data payloads in size.',
      },
      {
        label: 'Binary serialization',
        pros: 'Compact length-prefixed entries (count, then key-length/key/value-length/value). What Parquet (Thrift) and GeoTIFF (tags) chose.',
        cons: 'Opaque without the layout spec — you can see the structure in hex, but only because this tool’s format is deliberately simple.',
      },
      {
        label: 'Chunk index: include or omit',
        pros: 'Including it (default) lets the reader seek straight to any chunk’s offset.',
        cons: 'Omitting it saves bytes but the reader must compute offsets — impossible once any size-changing codec is in play (RLE, Dictionary, Deflate, GZip, Zstd). Read fails with no-chunk-index.',
      },
      {
        label: 'Endianness: include or omit',
        pros: 'Including it (default) records byte_order explicitly, so any reader — on any hardware — decodes multi-byte values correctly regardless of the byte order Write actually used.',
        cons: 'Omitting it does not fail the read: the reader silently assumes its own host order. If Write actually used the other order (see the Chunk section’s Byte order control), every multi-byte value decodes to the wrong number — no error, no warning, just quietly corrupt data.',
      },
    ],
    body:
      'Everything the pipeline decided so far gets recorded here, because the reader has ' +
      'none of your configuration — only bytes. This is also where "geo" formats stop being ' +
      'special: add a custom entry like crs = EPSG:4326 and you have done exactly what ' +
      'GeoTIFF does. The CRS is not magic; it is a string in a metadata dictionary. The ' +
      'chunk-index toggle is the sharpest lesson in the section: with RLE applied, chunk ' +
      'sizes are unpredictable, and without an index they are unlocatable — which is why ' +
      'every real chunked format carries one. The endianness toggle is the quietest lesson: ' +
      'every other missing-metadata failure in this tool is loud — Read stops and names what ' +
      'it was missing. Omitted byte order is the one exception. The reader has to guess ' +
      'something to keep going, so it guesses its own host order and proceeds; on a ' +
      'byte-order mismatch, Read still reports success, and only the diff view shows the ' +
      'reconstructed values are garbage. Real formats treat this as non-negotiable for exactly ' +
      'that reason — TIFF’s first two bytes are the byte order itself ("II" or "MM"), and ' +
      'network protocols standardize on big-endian ("network byte order") so no metadata is ' +
      'even needed.',
    tryIt:
      'Switch serialization to Binary and view the Metadata stage in hex — the keys are ' +
      'still visible in the ASCII column, each prefixed by its little-endian length. Then, ' +
      'with RLE on any variable, untick "Include chunk index" and watch the Read section ' +
      'fail with no-chunk-index. Separately: in the Chunk section, set Byte order to Big-endian, ' +
      'then here untick "Include endianness" — Read still says success, but open the diff view ' +
      'and watch the values that were actually written come back wrong.',
    links: BLOG_POSTS.filter((p) =>
      p.url.includes('metadata-makes-the-data-format-metadata-storage-and-representation-across-array-formats'),
    ),
  },
  {
    id: 'write',
    title: 'Write: where everything lands',
    section: 'write',
    decision:
      'Assemble the actual file(s): a magic number to identify the format, the metadata placed ' +
      'somewhere findable, and the encoded chunks in a chosen order — in one file or one file ' +
      'per chunk.',
    options: [
      {
        label: 'Metadata as header',
        pros: 'A reader can parse the file top-to-bottom in one pass — stream-friendly, like GeoTIFF’s leading IFD.',
        cons: 'The header’s chunk offsets depend on the header’s own size — the writer needs a convergence dance, and appending data means rewriting the front of the file.',
      },
      {
        label: 'Footer with trailer locator',
        pros: 'Write data first, metadata last — nothing to rewrite. The trailing [u32 length][magic] lets the reader seek from the end straight to the footer. This is literally Parquet’s layout.',
        cons: 'Requires a seekable source — a pure stream reader cannot start until the file ends.',
      },
      {
        label: 'Footer with no locator',
        pros: 'Saves the few trailer bytes; the layout looks tidier.',
        cons: 'The reader must scan backward guessing where metadata starts — and the scan may legitimately fail (metadata-not-found). That fragility is the lesson.',
      },
      {
        label: 'Sidecar / per-chunk files',
        pros: 'Metadata lives beside the data, not inside it — update it without touching data files. Per-chunk partitioning is Zarr’s directory model.',
        cons: 'Now there are multiple things to keep together; lose the sidecar and the data is uninterpretable bytes.',
      },
    ],
    body:
      'The magic number (default 00 C0 DE C5 — the tool’s own name) is the format’s ' +
      'handshake: Parquet writes PAR1, TIFF writes II* , and a reader checks it before ' +
      'trusting anything else. Placement is the deepest trade-off in this section: header ' +
      'favors streaming readers, footer favors writers (and object storage, where you cannot ' +
      'rewrite the front), sidecar favors mutability. Note that "Include metadata" defaults ' +
      'to off — the next step shows you exactly what a reader can do without it.',
    tryIt:
      'Set placement to footer and the Footer locator to "none": Read fails with ' +
      'metadata-not-found even though the metadata bytes are right there in the hex view. ' +
      'Flip the locator to "trailer" and find the 4-byte length + magic at the end of the ' +
      'file — Parquet’s trick, byte for byte.',
  },
  {
    id: 'read',
    title: 'Read: only the bytes remain',
    section: 'read',
    decision:
      'The reader gets the written files and the magic number it was built to expect — ' +
      'nothing else. Every structural fact must come from the file itself. The question this ' +
      'step answers: did you write enough for a stranger to reconstruct your data?',
    options: [
      {
        label: 'Self-describing file (metadata included)',
        pros: 'Any reader that understands the container can recover schema, chunks, codecs, and values — the file outlives the program that wrote it.',
        cons: 'The description costs bytes, and it must be findable (placement + locator) and complete (chunk index) — each is its own failure mode.',
      },
      {
        label: 'Bare data (metadata off — the default)',
        pros: 'The smallest possible file: magic and chunk bytes, nothing else.',
        cons: 'Unreadable without out-of-band knowledge. Read fails immediately with no-metadata — the extension’s central lesson.',
      },
    ],
    body:
      'The failure taxonomy is the curriculum: bad-magic (wrong or corrupt file — the reader ' +
      'refuses before parsing anything), no-metadata (nothing was written to describe the ' +
      'data), metadata-not-found (it was written, but the locator strategy could not pin it ' +
      'down), and no-chunk-index (variable-size chunks with no offsets recorded). Each names ' +
      'the write-side decision that caused it. On success, the diff view compares the ' +
      'round-trip against the original values — lossy type assignments and float Delta show ' +
      'up here as per-value differences, honestly attributed to the step that spent the ' +
      'precision. Five of the Metadata section’s six group toggles (schema, layout, codecs, ' +
      'chunk index, descriptive) each starve the reader of one specific fact — the sixth, ' +
      'endianness, misreads silently instead (see the Metadata step) — and the Read pane’s ' +
      'Process view narrates the eight-step attempt live, so you can watch exactly which step ' +
      'a missing group stops the reader at.',
    tryIt:
      'Turn on "Include metadata" in Write and watch Read flip from no-metadata to OK. Then ' +
      'corrupt the magic input (change one hex digit) and watch it fail with bad-magic — the ' +
      'reader never even looks for metadata. Fix it, enable the diff toggle, and inspect what ' +
      'your int16 temperature actually lost.',
  },
  {
    id: 'wrap-up',
    title: 'Wrap-up: you already know these formats',
    section: null,
    decision:
      'Every decision you just made — layout, chunking, orientation, dtypes, codecs, metadata ' +
      'placement — is the same menu every real format ordered from. The format presets in the ' +
      'header (Presets…) are those orders, written down, each loaded over a real public-domain ' +
      'dataset so the bytes are the format’s own, not the generator’s.',
    options: [],
    body:
      '"Parquet-adjacent" is tabular, column-oriented, per-column codecs — delta+deflate on the ' +
      'numeric columns, dictionary+RLE on the categorical station column — footer metadata with ' +
      'a length trailer, binary serialization. "Avro-esque" is the row-oriented counterpart on ' +
      'the same weather data: one shared per-chunk pipeline, header metadata, JSON. ' +
      '"GeoTIFFesque" is a 2-d array of a single elevation band, tiled 256×256 chunks, header ' +
      'metadata serialized to binary, with a Deflate chunk pipeline. "Zarrish" is a 2-d array, ' +
      'per-chunk files, sidecar ' +
      'JSON metadata, and Byte Shuffle + Zstd already applied — real Zarr’s default compressor ' +
      'is Zstd, and you can watch it work here without adding a thing. None of them is magic — ' +
      'each is one path through the sidebar you just walked. When a format ships a feature, it ' +
      'is answering one of these questions differently; when you read a spec, you now know which ' +
      'question each section answers.',
    tryIt:
      'The Presets… menu offers only the presets for the active data model. In Tabular, load ' +
      '"Parquet-adjacent" and walk the sidebar top to bottom, naming the option it picked at ' +
      'every step; then load "Avro-esque" and watch the same data flip to row orientation. ' +
      'Switch the data model to N-d Array and do the same for "GeoTIFFesque" and "Zarrish". On ' +
      'Zarrish, open the Codecs section and see the Byte Shuffle + Zstd pipeline the preset ' +
      'already carries — the differences between the four presets are the differences between ' +
      'the formats.',
  },
];
