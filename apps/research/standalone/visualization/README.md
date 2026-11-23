# Standalone scientific visualization

This directory is a runtime-local migration of the MLCC/Zeus scientific
visualization stack. It has no `@zeus` or parent-repository runtime imports.
The `.mjs` files are generated from the TypeScript sources with
`node:module.stripTypeScriptTypes` (Node 22+); parser behavior is otherwise
kept byte-for-byte at the source level.

Supported source families are EXTXYZ, XDATCAR, LAMMPS dump (including GIF
preview), CUBE, CHGCAR, ELFCAR, VASP EIGENVAL, and VASP DOSCAR. The local
`scientific-visualization.mjs` contains the shared manifest parser and limits.

The server stores derived resources below its private data directory through
the content-addressed visualization cache. Public resource URLs contain only
the manifest resource ID; they never expose a filesystem path or cache key.

## Standalone backend contract

The public endpoints prepare an authenticated artifact through
`prepareArtifactVisualization` and expose only the validated manifest and
opaque resource IDs:

* `GET /api/artifacts/:id/visualization` returns either a closed unsupported
  reason or a parsed ready manifest.
* `GET /api/artifacts/:id/visualization/resources/:resourceId` revalidates the
  manifest descriptor and streams the exact derived byte length.
* `GET /api/artifacts/:id` streams the original artifact with its exact stored
  length and download disposition.

Compared with the upstream server boundary, the standalone source adapter
receives an async byte iterable plus a trusted declared length. `readSource`
allocates that declared source buffer once and fills it as chunks arrive; it
does not retain a chunk array and then make a second full-size concatenation
copy before parsing. The adapter boundary still receives an isolated
`Uint8Array` copy, so this is a reduced-copy transport path rather than a
zero-copy promise. The 256 MiB source ceiling, exact-length check, iterator
cleanup, and abort signal remain enforced. Filename-based scientific MIME
normalization happens before the source enters adapter matching, so legacy
`application/octet-stream` artifacts can still use the scientific contract.

Worker uploads read confined files in bounded 64 KiB chunks. The server's raw
artifact and derived-resource responses use the shared exact-length
`streamArtifactBytes` path, apply backpressure, and stop/close the iterator on
client cancellation. No public visualization route turns the original file
into an unbounded server-side Blob.

Preparation is serialized at concurrency one in the standalone preprocessor.
Waiting requests carry an abort signal; cancelling a queued request removes it
from the queue, while cancellation during source reading closes the async
iterator. If a future backend moves preparation to another worker or queue,
it must preserve this single-preparation and cancellation contract rather than
reintroducing parallel unbounded parser work.

## Source hashes

The hashes below identify the source files from which the local modules were
migrated:

| source | SHA-256 |
| --- | --- |
| `apps/server/src/agent/visualization/visualization-preprocessor.ts` | `5973b41cf7b389b9772ec124addc2cfd9dba405aff4cc8dda490733560cdcff6` |
| `apps/server/src/agent/visualization/visualization-cache.ts` | `65295ef043624577640752a88bf0d1db4ddc9f47c8dbac7c0c136e8ffb3b46ec` |
| `apps/server/src/agent/visualization/trajectory-adapters.ts` | `069a2bae32910a2cb45c478e77c4b6ae8d0c5bdc262a84933695a7b6e91a5149` |
| `apps/server/src/agent/visualization/volume-adapters.ts` | `080d4b532932a9df697bb220e8098ca62fbf052c6959312d1b7078a98b0ae226` |
| `apps/server/src/agent/visualization/plot-adapters.ts` | `decbaaff6d928b232e318b9adcc021282c74496ac1d1bd4b05ccf4c21425487f` |
| `apps/server/src/agent/visualization/trajectory-gif.ts` | `ca24536de240b7d09878c4d4d2cb7ddeac7e86f39017bf5c7316e6c2cd2d30b1` |
| `packages/shared-types/src/scientific-visualization.ts` | `486211db39f1134c330468ba630a7f4019dad897db879e4288f6122cfb0786f3` |

`vendor/gifenc.cjs` and its license are vendored from `gifenc@1.0.3` so the
standalone release has no runtime package dependency.

## Independent parity tests

The original parser, cache, preprocessor, GIF, and manifest tests are copied
to `tests/` with only TypeScript type erasure and local import rewrites. Run
them directly from `mlcc-studio` with:

```sh
node --test standalone/visualization/tests/*.test.mjs
```

This README documents the standalone implementation and local test contract;
it does not claim that the service is publicly deployed or that every browser
environment has completed final acceptance.
