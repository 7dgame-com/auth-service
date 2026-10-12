# Authentication dependency audit, 2026-10-12

The `619e959` authentication baseline reported 6 production findings (including
2 critical dependency-chain entries) and 15 findings across the complete CI
dependency tree. This is a package-tree count, not a count of exploitable routes.
Raw npm audit JSON, containing only public package metadata, is saved under
`deploy/evidence/npm-audit-{production,full}-{before,after}.json`.

The final lock reports **0 production and 0 complete-tree findings**. Express
remains version 4. Runtime changes are compatible patch/minor releases. The test
runner moves from Vitest 2 to 4 to use the officially patched release; it is not
included by the runtime `npm ci --omit=dev` installation.

| Dependency | Final lock | Reason / observed use |
| --- | --- | --- |
| compression | 1.8.2 | Existing F middleware compresses public responses; fixes premature-close memory leak. [Maintainer advisory](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95) |
| express | 4.22.2 | Keeps the existing runtime framework major; corrected transitive packages are locked with overrides. |
| body-parser | 1.20.8 | Existing JSON/XML/form parsers use fixed valid limits; invalid-limit prerequisite is absent. The same-major patch removes the finding. [Maintainer advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-v422-hmwv-36x6) |
| qs | 6.16.0 | Used by Express query/form parsing; patch removes unsafe constructor/isBuffer behavior and prior array-limit issue. [Maintainer advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g) |
| proxy-addr | 2.0.8 | Existing `trust proxy=true` is already broad and does not configure the advisory's IPv6 trust subnet. The patch does not establish a trusted callback IP chain or enable plaintext relay. [Maintainer advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) |
| mysql2 | 3.24.5 | No inspected store/registry connection enables MySQL protocol compression; upgraded beyond the patched 3.23.1 minimum. [Maintainer advisory](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-rgwj-5xj2-c3m3) |
| vitest / @vitest/mocker | 4.1.11 | CI uses `vitest run`, not a public UI/dev server. Uses the patched version and removes vulnerable Tinypool from this dependency tree. [Maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) |
| vite / postcss / nanoid / source-map-js | 8.3.4 / 8.5.29 / 3.3.20 / 1.2.2 | Development-only dependencies resolved to patched releases. No Vite server is deployed. |

Generation used official npm 11.19 after npm 10.9.9's existing-tree resolver
failed with `Cannot read properties of null (reading 'edgesOut')`. npm 10.9.9
then successfully installed the new lock with a clean `npm ci`, without force,
legacy-peer-deps, audit exclusions, or weakened security checks. A temporary cache
was used; the user's system npm/cache configuration was not changed.

Verification on this final dependency tree: TypeScript build and lint passed;
**8 test files / 53 tests passed, 0 skipped**, including 7 real MySQL tests.
This includes empty/wrong AES AppID denial before relay or legacy writes and the
full loopback F → adapter → Identity-confirm contract using the real registry.
Compose validation passed without starting services. CI and candidate validation
now run npm audit before publishing. No image was published or deployed as part
of this preparation, and the AES/production-F authorization gates remain open.
