# 0x00C0DEC5

An interactive web tool for learning how data file formats are constructed.

Every file format -- Parquet, GeoTIFF, Zarr, HDF5 -- solves the same fundamental problems: how to structure data, encode it efficiently, and provide enough metadata to read it back. This tool lets you discover those problems firsthand by building a format from scratch.

## How it works

Define a dataset, then watch it transform step-by-step from human-readable values into raw bytes on disk. The transformation pipeline covers:

- **Chunking** -- splitting data into spatial slices
- **Interleaving** -- row-oriented (BIP) vs. column-oriented (BSQ) byte layout
- **Codecs** -- delta encoding, byte shuffle, bit rounding, scale/offset, RLE, LZ compression
- **Metadata assembly** -- JSON or binary serialization of structural and user-defined metadata
- **File assembly** -- magic numbers, metadata placement, chunk ordering, partitioning

A dual-pane comparison view lets you inspect any two pipeline stages side-by-side, with cross-pane hover tracing that links human-readable values to their encoded bytes.

## Use cases

**Live talks**: walk an audience through building a file format interactively, letting them choose options (row vs. column orientation, which codecs to apply) and see the consequences in real time.

**Self-guided exploration**: experiment independently with different format designs to understand why real-world formats make the choices they do.

## Development

Requires Node.js.

```bash
npm install
npm run dev       # start dev server at localhost:5173
npm run build     # production build
npm test          # run tests (watch mode)
npx vitest run    # run tests (single run)
```

## License

MIT
